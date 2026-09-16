import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createEmbedder, type Embedder } from "./embeddings";
import { baseDir } from "./paths";
import { buildCorpus, search, type CorpusEntry, type SearchOptions, type SearchResult } from "./search";
import { entryFragments } from "./transcript";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const indexPath = () => join(baseDir(), "search.sqlite");

function openIndex(): Database {
  mkdirSync(baseDir(), { recursive: true });
  const db = new Database(indexPath());
  chmodSync(indexPath(), 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS search_files (
      model TEXT NOT NULL, file TEXT NOT NULL, signature TEXT NOT NULL,
      PRIMARY KEY (model, file)
    );
    CREATE TABLE IF NOT EXISTS search_vectors (
      model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL,
      PRIMARY KEY (model, hash)
    );
    CREATE TABLE IF NOT EXISTS search_chunks (
      model TEXT NOT NULL, file TEXT NOT NULL, position INTEGER NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY (model, file, position)
    );
  `);
  return db;
}

interface Chunk {
  kind: "user" | "assistant";
  text: string;
  hash: string;
}

export function chunkText(kind: Chunk["kind"], text: string): Chunk[] {
  const chars = Array.from(text.trim());
  const chunks: Chunk[] = [];
  for (let start = 0; start < chars.length; start += 1050) {
    const text = chars.slice(start, start + 1200).join("").trim();
    if (text) chunks.push({ kind, text, hash: hash(text) });
    if (start + 1200 >= chars.length) break;
  }
  return chunks;
}

async function readChunks(meta: CorpusEntry, size: number): Promise<Chunk[]> {
  const chunks: Chunk[] = meta.task ? chunkText("user", meta.task) : [];
  if (size === 0) return chunks;
  const stream = createReadStream(meta.file, { encoding: "utf8", end: size - 1 });
  let pending = "";
  for await (const part of stream) {
    pending += part;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      for (const fragment of entryFragments(meta.provider, entry)) {
        if (fragment.kind !== "tool") chunks.push(...chunkText(fragment.kind, fragment.text));
      }
    }
  }
  // A writer may still be appending the last JSONL record.
  return chunks;
}

function signature(file: string): string {
  const stat = statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export async function indexConversations(
  opts: SearchOptions = {},
  embedder = createEmbedder(),
  progress?: (message: string) => void,
): Promise<{ files: number; skipped: number; embedded: number }> {
  const db = openIndex();
  const stats = { files: 0, skipped: 0, embedded: 0 };
  try {
    const corpus = buildCorpus(opts);
    for (const meta of corpus.values()) {
      const before = `${signature(meta.file)}:${hash(meta.task ?? "")}`;
      const previous = db.query("SELECT signature FROM search_files WHERE model = ? AND file = ?")
        .get(embedder.id, meta.file) as { signature: string } | null;
      if (previous?.signature === before) { stats.skipped++; continue; }
      progress?.(`Indexing ${meta.agentName ?? meta.sessionId ?? meta.file}`);
      const chunks = await readChunks(meta, statSync(meta.file).size);
      const missing = [...new Map(chunks.map((chunk) => [chunk.hash, chunk])).values()]
        .filter((chunk) => !db.query("SELECT 1 FROM search_vectors WHERE model = ? AND hash = ?").get(embedder.id, chunk.hash));
      for (let i = 0; i < missing.length; i += 32) {
        const batch = missing.slice(i, i + 32);
        const vectors = await embedder.embed(batch.map((chunk) => chunk.text), "document");
        db.transaction(() => {
          batch.forEach((chunk, j) => {
            db.query("INSERT OR REPLACE INTO search_vectors VALUES (?, ?, ?)")
              .run(embedder.id, chunk.hash, new Uint8Array(new Float32Array(vectors[j]!).buffer));
          });
        })();
        stats.embedded += batch.length;
      }
      // Publish complete files atomically. Changing transcripts get retried on the next run.
      if (`${signature(meta.file)}:${hash(meta.task ?? "")}` !== before) {
        progress?.(`Still changing: ${meta.agentName ?? meta.file}; run am index again after the turn finishes`);
        continue;
      }
      db.transaction(() => {
        db.query("DELETE FROM search_chunks WHERE model = ? AND file = ?").run(embedder.id, meta.file);
        chunks.forEach((chunk, position) => {
          db.query("INSERT INTO search_chunks VALUES (?, ?, ?, ?, ?, ?)")
            .run(embedder.id, meta.file, position, chunk.kind, chunk.text, chunk.hash);
        });
        db.query("INSERT OR REPLACE INTO search_files VALUES (?, ?, ?)").run(embedder.id, meta.file, before);
      })();
      stats.files++;
    }
    const files = db.query("SELECT DISTINCT file FROM search_files").all() as { file: string }[];
    db.transaction(() => {
      for (const { file } of files) {
        if (existsSync(file)) continue;
        db.query("DELETE FROM search_chunks WHERE file = ?").run(file);
        db.query("DELETE FROM search_files WHERE file = ?").run(file);
      }
    })();
    return stats;
  } finally { db.close(); }
}

export async function semanticSearch(
  query: string,
  opts: SearchOptions & { signal?: AbortSignal; onWarning?: (message: string) => void } = {},
  embedder?: Embedder,
): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  if (Array.from(query).length > 1200) throw new Error("Semantic search queries must be at most 1200 characters.");
  embedder ??= createEmbedder();
  if (!existsSync(indexPath())) throw new Error("No embedding index. Run am index first.");
  const db = openIndex();
  try {
    const corpus = buildCorpus(opts);
    const indexed = db.query("SELECT file, signature FROM search_files WHERE model = ?").all(embedder.id) as { file: string; signature: string }[];
    if (!indexed.some(({ file }) => corpus.has(file))) throw new Error("No indexed conversations for this model/scope. Run am index (or am index --all).");
    const signatures = new Map(indexed.map((row) => [row.file, row.signature]));
    const stale = [...corpus.values()].filter((meta) => signatures.get(meta.file) !== `${signature(meta.file)}:${hash(meta.task ?? "")}`).length;
    if (stale) opts.onWarning?.(`${stale} conversations are new or changed. Run am index${opts.all ? " --all" : ""} to refresh concept results.`);
    const [vector] = await embedder.embed([query], "query", opts.signal);
    const hits = new Map<string, { score: number; kind: Chunk["kind"]; text: string }[]>();
    const rows = db.query(`SELECT c.file, c.kind, c.text, v.vector FROM search_chunks c
      JOIN search_vectors v ON v.model = c.model AND v.hash = c.hash WHERE c.model = ?`);
    for (const row of rows.iterate(embedder.id) as Iterable<{ file: string; kind: Chunk["kind"]; text: string; vector: Uint8Array }>) {
      if (!corpus.has(row.file)) continue;
      const stored = new Float32Array(new Uint8Array(row.vector).buffer);
      if (stored.length !== vector!.length) throw new Error("Embedding dimensions changed; choose a different model or rebuild search.sqlite.");
      const score = stored.reduce((sum, n, i) => sum + n * vector![i]!, 0);
      const best = hits.get(row.file) ?? [];
      best.push({ score, kind: row.kind, text: row.text });
      best.sort((a, b) => b.score - a.score);
      hits.set(row.file, best.slice(0, 3));
    }
    const results: SearchResult[] = [];
    for (const [file, best] of hits) {
      const { file: _, task: _task, ...meta } = corpus.get(file)!;
      results.push({
        ...meta, score: best[0]!.score, matchCount: 0, updatedAt: statSync(file).mtimeMs,
        snippets: best.map(({ kind, text }) => ({ kind, text: text.replace(/\s+/g, " ").slice(0, 300), matchStart: 0, matchLen: 0 })),
      });
    }
    return results.sort((a, b) => b.score! - a.score! || b.updatedAt - a.updatedAt).slice(0, opts.limit ?? 20);
  } finally { db.close(); }
}

export function mergeHybrid(literal: SearchResult[], semantic: SearchResult[], limit = 20): SearchResult[] {
  const merged = new Map<string, { result: SearchResult; rank: number }>();
  for (const list of [literal, semantic]) {
    list.forEach((result, i) => {
      const key = `${result.host ?? ""}:${result.provider}:${result.agentName ?? result.sessionId ?? result.command}`;
      const existing = merged.get(key);
      merged.set(key, { result: existing?.result ?? result, rank: (existing?.rank ?? 0) + 1 / (60 + i + 1) });
    });
  }
  return [...merged.values()].sort((a, b) => b.rank - a.rank).slice(0, limit).map(({ result }) => result);
}

export async function searchWithEmbeddings(
  query: string,
  opts: SearchOptions & { hybrid?: boolean; signal?: AbortSignal; onWarning?: (message: string) => void } = {},
): Promise<SearchResult[]> {
  if (opts.fleet && !opts.localOnly) throw new Error("Embedding search is local. Use am -H <host> search --semantic to search a remote index.");
  const literal = opts.hybrid ? search(query, { ...opts, limit: Math.max(opts.limit ?? 20, 100) }) : [];
  try {
    const semantic = await semanticSearch(query, { ...opts, limit: Math.max(opts.limit ?? 20, 100) });
    return opts.hybrid ? mergeHybrid(literal, semantic, opts.limit) : semantic.slice(0, opts.limit ?? 20);
  } catch (error) {
    if (!opts.hybrid || opts.signal?.aborted) throw error;
    opts.onWarning?.(`Literal results only: ${error instanceof Error ? error.message : "Semantic search unavailable"}`);
    return literal.slice(0, opts.limit ?? 20);
  }
}
