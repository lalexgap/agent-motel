import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { codexHome } from "./codexHooks";
import { displayStatus, type DisplayStatus } from "./commands/ls";
import { loadConfig } from "./config";
import { claudeProjectsDir } from "./paths";
import { sshAm } from "./remote";
import { agentProvider, listAgents, type Provider } from "./state";
import { listTrashed } from "./trash";
import { entryFragments, locateTranscript } from "./transcript";

// `am search` — ripgrep full-text over agent transcripts. ripgrep does the
// whole local corpus in tens of milliseconds and returns each matched line in
// full, so we JSON.parse only matched lines (never whole files — transcripts
// reach 100MB+). Each matched line is run through entryFragments() to recover
// clean, role-labeled snippet text and to drop hits that landed in JSON
// structure rather than conversation content.

export type SearchScope = "agent" | "trash" | "history";
export type SearchAction = "jump" | "resume" | "restore" | "adopt";

export interface SearchSnippet {
  kind: "user" | "assistant" | "tool";
  text: string; // windowed around the match, whitespace collapsed
  matchStart: number; // offset of the match within text
  matchLen: number;
}

export interface SearchResult {
  agentName?: string; // absent for unregistered historical sessions
  host?: string; // set on federated (remote) results
  sessionId?: string;
  provider: Provider;
  dir?: string;
  status?: DisplayStatus; // registered agents only
  scope: SearchScope;
  action: SearchAction;
  command: string; // ready-to-run pick-up command
  matchCount: number;
  snippets: SearchSnippet[];
  updatedAt: number; // transcript mtime (ms) — ranking + display
}

export interface SearchOptions {
  all?: boolean; // widen to every historical session, not just registered + trash
  fleet?: boolean; // federate over config.remotes (suppressed by localOnly)
  localOnly?: boolean; // never recurse to remotes (set on the federated leg)
  limit?: number; // cap results (default 20)
  perFileCap?: number; // cap matches scanned per file (default 50)
}

interface CorpusEntry {
  file: string;
  provider: Provider;
  agentName?: string;
  sessionId?: string;
  dir?: string;
  status?: DisplayStatus;
  scope: SearchScope;
  action: SearchAction;
  command: string;
}

const SNIPPET_WINDOW = 80; // chars shown on each side of the match
const MAX_SNIPPETS = 3;
const DEFAULT_LIMIT = 20;
const DEFAULT_PER_FILE_CAP = 50;

const LIVE_STATUSES = new Set<DisplayStatus>(["starting", "idle", "working", "waiting", "needs-attention"]);

// Build the file→metadata map the search ranges over. Registered agents and
// trashed agents come first (they carry a name and a direct pick-up command);
// with --all, every other session on disk is added as an adoptable history hit.
function buildCorpus(opts: SearchOptions): Map<string, CorpusEntry> {
  const corpus = new Map<string, CorpusEntry>();

  for (const agent of listAgents()) {
    let file: string;
    try {
      file = locateTranscript(agent);
    } catch {
      continue; // no session captured yet
    }
    const status = displayStatus(agent);
    const live = LIVE_STATUSES.has(status);
    corpus.set(file, {
      file,
      provider: agentProvider(agent),
      agentName: agent.name,
      sessionId: agent.sessionId ?? agent.claudeSessionId,
      dir: agent.dir,
      status,
      scope: "agent",
      action: live ? "jump" : "resume",
      command: live ? `am j ${agent.name}` : `am resume ${agent.name}`,
    });
  }

  for (const trashed of listTrashed()) {
    let file: string;
    try {
      file = locateTranscript(trashed);
    } catch {
      continue;
    }
    if (corpus.has(file)) continue;
    corpus.set(file, {
      file,
      provider: agentProvider(trashed),
      agentName: trashed.name,
      sessionId: trashed.sessionId ?? trashed.claudeSessionId,
      dir: trashed.dir,
      scope: "trash",
      action: "restore",
      command: `am restore ${trashed.name}`,
    });
  }

  if (opts.all) {
    for (const { file, provider, sessionId } of walkHistory()) {
      if (corpus.has(file)) continue;
      corpus.set(file, {
        file,
        provider,
        sessionId,
        scope: "history",
        action: "adopt",
        command: sessionId ? `am new <name> --resume ${sessionId}` : `am new <name> --resume <id>`,
      });
    }
  }

  return corpus;
}

const CLAUDE_SESSION_ID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function* walkHistory(): Generator<{ file: string; provider: Provider; sessionId?: string }> {
  const claudeRoot = claudeProjectsDir();
  for (const file of walkJsonl(claudeRoot)) {
    const m = CLAUDE_SESSION_ID_RE.exec(basename(file));
    yield { file, provider: "claude", sessionId: m?.[1] ?? basename(file).replace(/\.jsonl$/, "") };
  }
  const codexRoot = join(codexHome(), "sessions");
  for (const file of walkJsonl(codexRoot)) {
    const m = CLAUDE_SESSION_ID_RE.exec(basename(file));
    yield { file, provider: "codex", sessionId: m?.[1] };
  }
}

function* walkJsonl(root: string): Generator<string> {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) stack.push(path);
      else if (e.name.endsWith(".jsonl")) yield path;
    }
  }
}

interface FileHits {
  matchCount: number;
  lines: string[]; // raw matched JSONL lines (deduped, capped)
}

// Run ripgrep over the corpus files. Fixed-string + smart-case-insensitive by
// default; we pass an explicit file list so the search never strays outside the
// chosen scope. Returns null when rg is unavailable so the caller can fall back.
function ripgrep(query: string, files: string[], perFileCap: number): Map<string, FileHits> | null {
  if (files.length === 0) return new Map();
  let proc;
  try {
    proc = Bun.spawnSync(
      ["rg", "--json", "-F", "-i", "-m", String(perFileCap), "-e", query, "--", ...files],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return null; // rg not installed
  }
  // rg exits 1 on "no matches" (not an error) and 2 on a real error.
  if (proc.exitCode === 2 && proc.stdout.length === 0) return null;
  return parseRgJson(proc.stdout.toString(), perFileCap);
}

function parseRgJson(stdout: string, perFileCap: number): Map<string, FileHits> {
  const byFile = new Map<string, FileHits>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const file: string = event.data.path.text;
    const submatches: unknown[] = event.data.submatches ?? [];
    const hits = byFile.get(file) ?? { matchCount: 0, lines: [] };
    hits.matchCount += submatches.length || 1;
    if (hits.lines.length < perFileCap) hits.lines.push(event.data.lines.text);
    byFile.set(file, hits);
  }
  return byFile;
}

// Pure-Bun fallback when ripgrep is absent: a per-line case-insensitive scan
// over the same files. Slower, but keeps am self-contained.
function scanFallback(query: string, files: string[], perFileCap: number): Map<string, FileHits> {
  const needle = query.toLowerCase();
  const byFile = new Map<string, FileHits>();
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hits: FileHits = { matchCount: 0, lines: [] };
    for (const line of content.split("\n")) {
      if (!line) continue;
      if (!line.toLowerCase().includes(needle)) continue;
      hits.matchCount += 1;
      if (hits.lines.length < perFileCap) hits.lines.push(line);
    }
    if (hits.matchCount > 0) byFile.set(file, hits);
  }
  return byFile;
}

// Turn one file's raw matched lines into clean snippets, dropping lines whose
// hit was in JSON structure rather than conversation content. Conversational
// hits (user/assistant) are surfaced ahead of tool hits — a match in a chat
// message is what someone hunting for an old session usually means, not a file
// path that happened to scroll past in a tool call.
function snippetsFor(provider: Provider, lines: string[], query: string): SearchSnippet[] {
  const needle = query.toLowerCase();
  const candidates: SearchSnippet[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const frag of entryFragments(provider, entry)) {
      const idx = frag.text.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const snippet = windowSnippet(frag.kind, frag.text, idx, query.length);
      if (seen.has(snippet.text)) continue;
      seen.add(snippet.text);
      candidates.push(snippet);
    }
  }
  const convoFirst = (s: SearchSnippet) => (s.kind === "tool" ? 1 : 0);
  candidates.sort((a, b) => convoFirst(a) - convoFirst(b));
  return candidates.slice(0, MAX_SNIPPETS);
}

function windowSnippet(
  kind: SearchSnippet["kind"],
  text: string,
  idx: number,
  matchLen: number,
): SearchSnippet {
  const start = Math.max(0, idx - SNIPPET_WINDOW);
  const end = Math.min(text.length, idx + matchLen + SNIPPET_WINDOW);
  let slice = text.slice(start, end);
  const lead = start > 0 ? "…" : "";
  const trail = end < text.length ? "…" : "";
  // Collapse whitespace/newlines for a compact one-line snippet; track how the
  // collapse shifts the match offset so highlighting stays aligned.
  const before = slice.slice(0, idx - start);
  const collapsedBefore = lead + before.replace(/\s+/g, " ");
  const collapsed = lead + slice.replace(/\s+/g, " ") + trail;
  return {
    kind,
    text: collapsed,
    matchStart: collapsedBefore.length,
    matchLen,
  };
}

function scopeRank(scope: SearchScope): number {
  return scope === "agent" ? 0 : scope === "trash" ? 1 : 2;
}

function rank(a: SearchResult, b: SearchResult): number {
  const aLive = a.status && LIVE_STATUSES.has(a.status) ? 0 : 1;
  const bLive = b.status && LIVE_STATUSES.has(b.status) ? 0 : 1;
  if (aLive !== bLive) return aLive - bLive;
  const sa = scopeRank(a.scope);
  const sb = scopeRank(b.scope);
  if (sa !== sb) return sa - sb;
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return b.matchCount - a.matchCount;
}

function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Local search: build the corpus, ripgrep it, attach snippets, rank.
function searchLocal(query: string, opts: SearchOptions): SearchResult[] {
  const corpus = buildCorpus(opts);
  const files = [...corpus.keys()];
  const perFileCap = opts.perFileCap ?? DEFAULT_PER_FILE_CAP;
  const hits = ripgrep(query, files, perFileCap) ?? scanFallback(query, files, perFileCap);

  const results: SearchResult[] = [];
  for (const [file, fileHits] of hits) {
    const meta = corpus.get(file);
    if (!meta) continue;
    const snippets = snippetsFor(meta.provider, fileHits.lines, query);
    if (snippets.length === 0) continue; // every hit was JSON structure / noise
    results.push({
      agentName: meta.agentName,
      sessionId: meta.sessionId,
      provider: meta.provider,
      dir: meta.dir,
      status: meta.status,
      scope: meta.scope,
      action: meta.action,
      command: meta.command,
      matchCount: fileHits.matchCount,
      snippets,
      updatedAt: mtimeMs(file),
    });
  }
  results.sort(rank);
  return results.slice(0, opts.limit ?? DEFAULT_LIMIT);
}

// Federate over config.remotes, mirroring fleet's `am ls --json --local-only`
// pattern: each host runs the same search locally and returns JSON we merge.
function searchRemotes(query: string, opts: SearchOptions): SearchResult[] {
  const out: SearchResult[] = [];
  for (const host of loadConfig().remotes ?? []) {
    const args = ["search", "--json", "--local-only", query];
    if (opts.all) args.push("--all");
    const res = sshAm(host, args, { timeoutMs: 8000 });
    if (res.exitCode !== 0 && res.exitCode !== 1) continue; // unreachable / error
    let rows: SearchResult[];
    try {
      rows = JSON.parse(res.stdout) as SearchResult[];
    } catch {
      continue;
    }
    for (const r of rows) {
      r.host = host;
      // Rewrite the pick-up command to target the remote agent.
      if (r.agentName && r.action !== "adopt") {
        r.command = `am -H ${host} ${r.action === "jump" ? "j" : r.action} ${r.agentName}`;
      } else if (r.action === "adopt") {
        r.command = `am -H ${host} ${r.command.replace(/^am /, "")}`;
      }
      out.push(r);
    }
  }
  return out;
}

// Reduce results to the local registered agents the picker can actually select
// (a row in its list), preserving search rank and dropping remote, history, and
// duplicate hits. Returns the ordered names plus each agent's lead snippet.
export function localAgentMatches(results: SearchResult[]): { order: string[]; snippets: Map<string, string> } {
  const snippets = new Map<string, string>();
  const order: string[] = [];
  for (const r of results) {
    if (!r.agentName || r.host || r.scope !== "agent" || snippets.has(r.agentName)) continue;
    snippets.set(r.agentName, r.snippets[0]?.text ?? "");
    order.push(r.agentName);
  }
  return { order, snippets };
}

export function search(query: string, opts: SearchOptions = {}): SearchResult[] {
  const local = searchLocal(query, opts);
  if (opts.localOnly || !opts.fleet) return local;
  const merged = [...local, ...searchRemotes(query, opts)];
  merged.sort(rank);
  return merged.slice(0, opts.limit ?? DEFAULT_LIMIT);
}
