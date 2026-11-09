import { closeSync, constants, fstatSync, openSync, opendirSync, readSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { codexHome } from "./codexHooks";
import { displayStatus, type DisplayStatus } from "./commands/ls";
import { loadConfig } from "./config";
import { claudeProjectsDir } from "./paths";
import { sshAmStreamArgv } from "./remote";
import { agentProvider, agentSessionId, listAgents, type AgentState, type Provider } from "./state";
import { listTrashed } from "./trash";
import { entryFragments, locateTranscript, TranscriptLookupLimitError } from "./transcript";

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
  budgets?: Partial<SearchBudgets>; // may lower, never raise, the hard limits
}

export interface SearchBudgets {
  maxBytes: number;
  maxLineBytes: number;
  maxLines: number;
  maxFiles: number;
  maxMs: number;
  maxOutputBytes: number;
}
export const SEARCH_BUDGETS: Readonly<SearchBudgets> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxLines: 250_000,
  maxFiles: 10_000,
  maxMs: 8000,
  maxOutputBytes: 2 * 1024 * 1024,
});
export interface SearchMetadata {
  partial: boolean;
  local: {
    reasons: string[];
    bytesRead: number;
    linesRead: number;
    filesScanned: number;
    peakLineBytes: number;
  };
  hosts: { host: string; partial: boolean; reasons: string[] }[];
  reasons: string[];
}
// JSON.stringify deliberately keeps the legacy array wire contract.
export type SearchResults = SearchResult[] & { metadata: SearchMetadata };
interface SearchContext {
  budgets: SearchBudgets;
  deadline: number;
  metadata: SearchMetadata;
}
function note(ctx: SearchContext, reason: string): void {
  ctx.metadata.partial = true;
  if (!ctx.metadata.local.reasons.includes(reason)) ctx.metadata.local.reasons.push(reason);
}
function timedOut(ctx: SearchContext): boolean {
  if (performance.now() < ctx.deadline) return false;
  note(ctx, "time");
  return true;
}
function boundedOption(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("search limits must be positive integers");
  return Math.min(value, max);
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

function searchTranscript(agent: AgentState, ctx: SearchContext): string | undefined {
  try {
    if (agent.transcriptPath) {
      try {
        if (!statSync(agent.transcriptPath).isFile()) { note(ctx, "unreadable-file"); return; }
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return locateTranscript(agent, { maxLegacyBytes: Math.min(ctx.budgets.maxLineBytes, ctx.budgets.maxBytes) });
  } catch (error) {
    if (error instanceof TranscriptLookupLimitError) note(ctx, "lookup-bytes");
    else if (agent.transcriptPath || agentSessionId(agent) || agent.antigravityRunId) note(ctx, "transcript-unavailable");
  }
}

// Build the file→metadata map the search ranges over. Registered agents and
// trashed agents come first (they carry a name and a direct pick-up command);
// with --all, every other session on disk is added as an adoptable history hit.
function buildCorpus(opts: SearchOptions, ctx: SearchContext): Map<string, CorpusEntry> {
  const corpus = new Map<string, CorpusEntry>();

  for (const agent of listAgents()) {
    if (timedOut(ctx)) break;
    if (corpus.size >= ctx.budgets.maxFiles) { note(ctx, "files"); break; }
    const file = searchTranscript(agent, ctx);
    if (!file) continue;
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
    if (timedOut(ctx)) break;
    if (corpus.size >= ctx.budgets.maxFiles) { note(ctx, "files"); break; }
    const file = searchTranscript(trashed, ctx);
    if (!file) continue;
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
    for (const { file, provider, sessionId } of walkHistory(ctx)) {
      if (timedOut(ctx)) break;
      if (corpus.size >= ctx.budgets.maxFiles) { note(ctx, "files"); break; }
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

function* walkHistory(ctx: SearchContext): Generator<{ file: string; provider: Provider; sessionId?: string }> {
  const claudeRoot = claudeProjectsDir();
  for (const file of walkJsonl(claudeRoot, ctx)) {
    const m = CLAUDE_SESSION_ID_RE.exec(basename(file));
    yield { file, provider: "claude", sessionId: m?.[1] ?? basename(file).replace(/\.jsonl$/, "") };
  }
  const codexRoot = join(codexHome(), "sessions");
  for (const file of walkJsonl(codexRoot, ctx)) {
    const m = CLAUDE_SESSION_ID_RE.exec(basename(file));
    yield { file, provider: "codex", sessionId: m?.[1] };
  }
}

function* walkJsonl(root: string, ctx: SearchContext): Generator<string> {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (timedOut(ctx)) return;
    const dir = stack.pop()!;
    let handle;
    try { handle = opendirSync(dir); } catch (error: any) {
      if (error.code !== "ENOENT") note(ctx, "unreadable-directory");
      continue;
    }
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (timedOut(ctx)) return;
        if (++visited > ctx.budgets.maxFiles * 10) { note(ctx, "discovery-entries"); return; }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
      }
    } finally { handle.closeSync(); }
  }
}

interface FileHits {
  matchCount: number;
  snippets: SearchSnippet[];
}

function scanFile(file: string, provider: Provider, query: string, cap: number, ctx: SearchContext): FileHits {
  const hits: FileHits = { matchCount: 0, snippets: [] };
  const stats = ctx.metadata.local;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); } catch { note(ctx, "unreadable-file"); return hits; }
  try {
    if (!fstatSync(fd).isFile()) { note(ctx, "unreadable-file"); return hits; }
    stats.filesScanned++;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, ctx.budgets.maxBytes));
    const record = Buffer.allocUnsafe(ctx.budgets.maxLineBytes);
    let length = 0, skipping = false, matchedLines = 0, fileBytes = 0;
    const consume = () => {
      stats.linesRead++;
      if (!skipping && length) {
        const raw = record.toString("utf8", 0, length);
        const lower = raw.toLowerCase(), needle = query.toLowerCase();
        let offset = 0, count = 0;
        while ((offset = lower.indexOf(needle, offset)) >= 0) { count++; offset += needle.length; }
        if (count) {
          matchedLines++;
          hits.matchCount += count;
          hits.snippets.push(...snippetsFor(provider, [raw], query));
          hits.snippets = hits.snippets.filter((s, i, all) => all.findIndex(other => other.text === s.text) === i)
            .sort((a, b) => Number(a.kind === "tool") - Number(b.kind === "tool")).slice(0, MAX_SNIPPETS);
        }
      }
      length = 0;
      skipping = false;
    };
    while (true) {
      if (timedOut(ctx)) break;
      if (stats.linesRead >= ctx.budgets.maxLines) { note(ctx, "lines"); break; }
      if (stats.bytesRead >= ctx.budgets.maxBytes) {
        if (fileBytes >= fstatSync(fd).size) { if (length || skipping) consume(); }
        else note(ctx, "bytes");
        break;
      }
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, ctx.budgets.maxBytes - stats.bytesRead), null);
      stats.bytesRead += size;
      fileBytes += size;
      if (!size) { if (length || skipping) consume(); break; }
      let offset = 0;
      while (offset < size) {
        if (timedOut(ctx)) return hits;
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 || newline >= size ? size : newline;
        if (!skipping) {
          const partLength = end - offset;
          if (length + partLength > record.length) {
            length = 0; skipping = true; note(ctx, "line-bytes");
          } else {
            chunk.copy(record, length, offset, end);
            length += partLength;
            stats.peakLineBytes = Math.max(stats.peakLineBytes, length);
          }
        }
        offset = end + 1;
        if (end < size) {
          consume();
          if (matchedLines >= cap) { note(ctx, "per-file-matches"); return hits; }
          if (stats.linesRead >= ctx.budgets.maxLines) { note(ctx, "lines"); return hits; }
        }
      }
    }
  } catch { note(ctx, "unreadable-file"); }
  finally { closeSync(fd); }
  return hits;
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

function searchLocal(query: string, opts: SearchOptions, ctx: SearchContext): SearchResult[] {
  const corpus = buildCorpus(opts, ctx);
  const cap = boundedOption(opts.perFileCap, DEFAULT_PER_FILE_CAP, 1000);
  const limit = boundedOption(opts.limit, DEFAULT_LIMIT, 1000);
  const results: SearchResult[] = [];
  for (const [file, meta] of corpus) {
    if (timedOut(ctx)) break;
    if (ctx.metadata.local.bytesRead >= ctx.budgets.maxBytes) { note(ctx, "bytes"); break; }
    if (ctx.metadata.local.linesRead >= ctx.budgets.maxLines) { note(ctx, "lines"); break; }
    const fileHits = scanFile(file, meta.provider, query, cap, ctx);
    if (!fileHits.snippets.length) continue;
    results.push({
      agentName: meta.agentName, sessionId: meta.sessionId, provider: meta.provider,
      dir: meta.dir, status: meta.status, scope: meta.scope, action: meta.action,
      command: meta.command, matchCount: fileHits.matchCount, snippets: fileHits.snippets,
      updatedAt: mtimeMs(file),
    });
    results.sort(rank);
    if (results.length > limit) { results.pop(); note(ctx, "results"); }
  }
  return results;
}

function validResult(row: any): row is SearchResult {
  return row && ["claude", "codex", "antigravity"].includes(row.provider)
    && ["agent", "trash", "history"].includes(row.scope)
    && ["jump", "resume", "restore", "adopt"].includes(row.action)
    && typeof row.command === "string" && Number.isFinite(row.matchCount) && Number.isFinite(row.updatedAt)
    && [row.agentName, row.sessionId, row.dir, row.status].every(value => value === undefined || typeof value === "string")
    && Array.isArray(row.snippets) && row.snippets.length <= MAX_SNIPPETS
    && row.snippets.every((s: any) => s && ["user", "assistant", "tool"].includes(s.kind)
      && typeof s.text === "string" && Number.isFinite(s.matchStart) && Number.isFinite(s.matchLen));
}

function searchRemotes(query: string, opts: SearchOptions, ctx: SearchContext): SearchResult[] {
  const out: SearchResult[] = [];
  const remotes = loadConfig().remotes ?? [];
  for (const host of remotes.slice(0, 16)) {
    const evidence = { host, partial: false, reasons: [] as string[] };
    ctx.metadata.hosts.push(evidence);
    const fail = (reason: string) => { evidence.partial = true; evidence.reasons.push(reason); ctx.metadata.partial = true; };
    const remaining = Math.floor(ctx.deadline - performance.now());
    if (remaining <= 0) { fail("time"); continue; }
    const args = ["search", "--json", "--metadata", "--local-only", "--limit", String(opts.limit ?? DEFAULT_LIMIT)];
    if (opts.all) args.push("--all");
    args.push("--", query);
    let stdout: string;
    try {
      const [command, ...argv] = sshAmStreamArgv(host, args);
      stdout = execFileSync(command!, argv, {
        encoding: "utf8", timeout: remaining, killSignal: "SIGKILL",
        maxBuffer: ctx.budgets.maxOutputBytes, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: any) {
      fail(error.code === "ETIMEDOUT" ? "time" : error.code === "ENOBUFS" ? "output-bytes" : "remote-error");
      continue;
    }
    let payload: any;
    try { payload = JSON.parse(stdout); } catch { fail("invalid-response"); continue; }
    const rows = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(rows) || rows.length > 1000 || !rows.every(validResult)) { fail("invalid-response"); continue; }
    // Older peers return an array and cannot attest that their scan completed.
    if (Array.isArray(payload)) fail("legacy-completeness-unknown");
    else if (typeof payload.metadata?.partial !== "boolean") { fail("invalid-response"); continue; }
    else if (payload.metadata.partial) fail("remote-partial");
    for (const row of rows) {
      const r = { ...row, host };
      if (r.agentName && r.action !== "adopt") r.command = `am -H ${host} ${r.action === "jump" ? "j" : r.action} ${r.agentName}`;
      else if (r.action === "adopt") r.command = `am -H ${host} ${r.command.replace(/^am /, "")}`;
      out.push(r);
    }
  }
  if (remotes.length > 16) { ctx.metadata.partial = true; ctx.metadata.reasons.push("fleet-hosts"); }
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

export function search(query: string, opts: SearchOptions = {}): SearchResults {
  if (!query.trim() || query.length > 256) throw new Error("search query must be 1–256 characters");
  const budgets = { ...SEARCH_BUDGETS };
  for (const key of Object.keys(budgets) as (keyof SearchBudgets)[]) {
    budgets[key] = boundedOption(opts.budgets?.[key], budgets[key], budgets[key]);
  }
  const metadata: SearchMetadata = {
    partial: false,
    local: { reasons: [], bytesRead: 0, linesRead: 0, filesScanned: 0, peakLineBytes: 0 },
    hosts: [], reasons: [],
  };
  const ctx: SearchContext = { budgets, deadline: performance.now() + budgets.maxMs, metadata };
  const limit = boundedOption(opts.limit, DEFAULT_LIMIT, 1000);
  const local = searchLocal(query, opts, ctx);
  const merged = opts.localOnly || !opts.fleet ? local : [...local, ...searchRemotes(query, { ...opts, limit }, ctx)];
  merged.sort(rank);
  if (merged.length > limit) { metadata.partial = true; metadata.reasons.push("results"); }
  const results: SearchResult[] = [];
  let bytes = 2;
  for (const result of merged.slice(0, limit)) {
    bytes += Buffer.byteLength(JSON.stringify(result)) + (results.length ? 1 : 0);
    if (bytes > budgets.maxOutputBytes) { metadata.partial = true; metadata.reasons.push("output-bytes"); break; }
    results.push(result);
  }
  return Object.assign(results, { metadata });
}

export function searchWarning(metadata: SearchMetadata): string | undefined {
  if (!metadata.partial) return;
  const local = metadata.local.reasons.length ? `local: ${metadata.local.reasons.join(", ")}` : "";
  const hosts = metadata.hosts.filter(host => host.partial).map(host => `${host.host}: ${host.reasons.join(", ")}`);
  return `Partial search results (${[local, ...hosts, ...metadata.reasons].filter(Boolean).join("; ")}).`;
}
