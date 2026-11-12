// web/search.js reads app.js globals and wires its form on load, so its rules are
// reimplemented here; tests/desktopSearch.test.ts checks the shared ones agree.
import type { AgentRow, ApiResponse } from "./types";

export const SNIPPETS_PER_AGENT = 3;
export const BUSY_MESSAGE = "Search is busy. Try again shortly.";
export const QUERY_HINT = "Enter 2–256 characters to search conversations.";
export const NO_MATCHES = "No matches. Try fewer words or clear a filter.";

export type SortKey = "recent" | "runtime" | "repo" | "status" | "name";
export type SearchMode = "agents" | "conversations";
export interface SearchFilters {
  repository: string;
  host: string;
  provider: string;
  status: string;
  sort: SortKey;
}
export const DEFAULT_FILTERS: SearchFilters = { repository: "", host: "", provider: "", status: "", sort: "recent" };

export interface SearchRow {
  key: string;
  connection: string;
  connectionName: string;
  row: AgentRow;
}

export interface Snippet {
  kind: string;
  text: string;
}

// Kept equal to web/search.js by tests/desktopSearch.test.ts.

export function searchExcerpt(text: unknown, terms: string[], length = 220): string {
  const flat = String(text || "").replace(/\*\*|`|(^|\s)#{1,6}(?=\s)/g, "$1").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = flat.length <= length || first < length / 3 ? 0 : Math.min(first - Math.floor(length / 3), flat.length - length);
  const end = Math.min(flat.length, start + length);
  return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}

// Matched terms become <mark> elements, everything else text nodes: never markup.
export function highlightInto<T extends Node>(node: T, text: string, terms: string[]): T {
  const pattern = terms.length ? new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null;
  let offset = 0;
  for (const match of pattern ? text.matchAll(pattern) : []) {
    if (!match[0]) continue;
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    (node as unknown as ParentNode).append(document.createTextNode(text.slice(offset, match.index)), mark);
    offset = match.index! + match[0].length;
  }
  (node as unknown as ParentNode).append(document.createTextNode(text.slice(offset)));
  return node;
}

export const repoPath = (row: Pick<AgentRow, "repoRoot" | "dir">): string => row.repoRoot || row.dir || "";
export const hostOf = (row: Pick<AgentRow, "host">): string => row.host || "local";

// -1 unless working or waiting.
export function runtime(row: Pick<AgentRow, "status" | "statusChangedAt">, now = Date.now()): number {
  if (row.status !== "working" && row.status !== "waiting") return -1;
  const start = Date.parse(row.statusChangedAt || "");
  return Number.isFinite(start) ? Math.max(0, now - start) : -1;
}

export function elapsed(ms: number): string {
  if (ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const queryTerms = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

export function matchesTerms(row: AgentRow, terms: string[]): boolean {
  const text = [row.name, row.task, row.dir, repoPath(row), row.worktreeBranch, row.spawnedBy, row.provider, hostOf(row)].join(" ").toLowerCase();
  return terms.every((term) => text.includes(term));
}

const FINISHED = new Set(["dead", "exited"]);
export function matchesFilters(row: AgentRow, filters: SearchFilters): boolean {
  const finished = FINISHED.has(row.status);
  const { repository, host, provider, status } = filters;
  return (!repository || repoPath(row) === repository) && (!host || hostOf(row) === host) && (!provider || row.provider === provider) &&
    (!status || (status === "live" ? !finished : status === "finished" ? finished : row.status === status));
}

// Every term must match the agent's details unless its conversation matched.
export function filterRows(rows: SearchRow[], terms: string[], filters: SearchFilters, conversationHit: (key: string) => boolean = () => false): SearchRow[] {
  return rows.filter((entry) => (matchesTerms(entry.row, terms) || conversationHit(entry.key)) && matchesFilters(entry.row, filters));
}

// The browser UI's order, quirks included: "name" has no branch of its own and
// sorts by the name tie-break, "status" compares the status strings, and
// "runtime" puts every agent that is not working or waiting (-1) last.
export function sortRows(rows: SearchRow[], sort: SortKey, now = Date.now()): SearchRow[] {
  return rows.sort(({ row: a }, { row: b }) => {
    let order = 0;
    if (sort === "recent") order = Date.parse((b.updatedAt || b.createdAt || 0) as string) - Date.parse((a.updatedAt || a.createdAt || 0) as string);
    else if (sort === "runtime") order = runtime(b, now) - runtime(a, now);
    else if (sort === "repo") order = repoPath(a).localeCompare(repoPath(b));
    else if (sort === "status") order = String(a.status).localeCompare(String(b.status));
    return order || a.name.localeCompare(b.name);
  });
}

// Keeps the current choice after its last agent is gone, so a filter never silently resets.
export function optionValues(values: string[], previous: string): string[] {
  const entries = [...new Set(values)].sort();
  if (previous && !entries.includes(previous)) entries.push(previous);
  return entries;
}

export const validConversationQuery = (query: string): boolean => query.length >= 2 && query.length <= 256;

export interface ConnectionResult {
  connection: string;
  name: string;
  pending: boolean;
  error?: string;
  partial?: boolean;
  unavailable?: string[];
  // Snippets by agent key (connection/host:name).
  matches?: Map<string, Snippet[]>;
}

export interface ConversationSearch {
  query: string;
  seq: number;
  results: Map<string, ConnectionResult>;
}

export function beginSearch(query: string, seq: number, connections: { id: string; name: string }[]): ConversationSearch {
  return { query, seq, results: new Map(connections.map(({ id, name }) => [id, { connection: id, name, pending: true }])) };
}

// Drops responses for an older search or a connection the search did not include.
export function applyResult(search: ConversationSearch | null, seq: number, result: ConnectionResult): boolean {
  if (!search || search.seq !== seq || !search.results.has(result.connection)) return false;
  search.results.set(result.connection, { ...result, pending: false });
  return true;
}

const errorText = (body: unknown): string | null => {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && error ? error : null;
};

function shapeSnippets(value: unknown): Snippet[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((snippet): snippet is Snippet => !!snippet && typeof snippet.kind === "string" && typeof snippet.text === "string")
    .slice(0, SNIPPETS_PER_AGENT)
    .map(({ kind, text }) => ({ kind, text }));
}

export function readResponse(connection: string, name: string, response: ApiResponse): ConnectionResult {
  const base = { connection, name, pending: false };
  if (response.status === 429) return { ...base, error: BUSY_MESSAGE };
  if (response.status === 401) return { ...base, error: "Token rejected (401)" };
  if (response.status < 200 || response.status >= 300) return { ...base, error: errorText(response.body) ?? `HTTP ${response.status}` };
  const body = (response.body ?? {}) as { matches?: unknown; partial?: unknown; unavailable?: unknown };
  const matches = new Map<string, Snippet[]>();
  for (const match of Array.isArray(body.matches) ? body.matches : []) {
    if (!match || typeof match.name !== "string") continue;
    const id = (typeof match.host === "string" && match.host ? match.host + ":" : "") + match.name;
    matches.set(`${connection}/${id}`, shapeSnippets(match.snippets));
  }
  const unavailable = Array.isArray(body.unavailable) ? body.unavailable.filter((host): host is string => typeof host === "string") : [];
  return { ...base, matches, partial: body.partial === true, unavailable };
}

export function failure(connection: string, name: string, error: unknown): ConnectionResult {
  return { connection, name, pending: false, error: error instanceof Error ? error.message : String(error) };
}

export function snippetsFor(search: ConversationSearch | null, key: string): Snippet[] | undefined {
  if (!search) return undefined;
  const slash = key.indexOf("/");
  return search.results.get(key.slice(0, slash))?.matches?.get(key);
}

export const snippetLabel = (kind: string): string => (kind === "user" ? "You" : kind === "assistant" ? "Agent" : kind);

export function summaryText(shown: number, total: number, mode: SearchMode, search: ConversationSearch | null): string {
  let text = `${shown} of ${total} agents · includes child and finished agents`;
  if (mode !== "conversations") return text;
  const results = search ? [...search.results.values()] : [];
  const multi = results.length > 1;
  const named = (result: ConnectionResult, value: string) => (multi ? `${result.name}: ${value}` : value);
  let hint: string;
  if (!search) hint = "Press Search or Enter to include conversations.";
  else if (results.some((result) => result.pending)) hint = "Searching conversations…";
  else {
    const errors = results.filter((result) => result.error).map((result) => named(result, result.error!));
    const done = results.filter((result) => !result.error);
    const parts = [...errors];
    if (done.length) {
      parts.push(done.some((result) => result.partial)
        ? "Partial results: search reached a limit or some transcripts were unavailable."
        : "Conversation search complete · up to 3 snippets per agent");
    }
    hint = parts.join(" · ") || "Conversation search complete · up to 3 snippets per agent";
  }
  const unavailable = results.flatMap((result) => (result.unavailable ?? []).map((host) => named(result, host)));
  text += " · " + hint + (unavailable.length ? " Unavailable hosts: " + unavailable.join(", ") : "");
  return text;
}
