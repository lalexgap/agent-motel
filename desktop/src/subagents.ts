// Pure parts of subagents: built-in subagent records (labels, status, order,
// tokens), keys for one subagent, AM parent/child agents, and which running
// subagents nest under which sidebar rows. The views are inspector.ts (the
// "Agents & subagents" section) and subagentView.ts (the transcript).
import { ATTENTION_GROUP, STOPPED, type SubagentItem, type TreeItem } from "./fleet";
import type { AgentRow, RunningSubagent, SubagentRecord, SubagentTokens } from "./types";

// What am accepts for `?subagent=`.
export const SUBAGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// One subagent, app-wide: `<agent key>#<subagent id>`. Agent keys never hold a `#`.
export const subagentKey = (key: string, id: string): string => `${key}#${id}`;
export function parseSubagentKey(key: string): { agentKey: string; id: string } | null {
  const hash = key.lastIndexOf("#");
  if (hash <= 0) return null;
  const id = key.slice(hash + 1);
  return SUBAGENT_ID_RE.test(id) ? { agentKey: key.slice(0, hash), id } : null;
}

export const subagentTranscriptPath = (agentPath: string, id: string): string => `${agentPath}/transcript?subagent=${encodeURIComponent(id)}`;

export const subagentLabel = (record: { description?: string; type?: string; id?: string }): string =>
  record.description?.trim() || record.type || record.id || "subagent";

export type SubagentState = "running" | "finished" | "stale";
export const SUBAGENT_STATUS: Record<SubagentState, string> = { running: "Running", finished: "Finished", stale: "Session ended" };

// A record still open is stale once the server says so, or once its agent has stopped.
export function subagentState(record: Pick<SubagentRecord, "endedAt" | "stale">, agentStatus?: string): SubagentState {
  if (record.endedAt) return "finished";
  if (record.stale || (agentStatus !== undefined && STOPPED.has(agentStatus))) return "stale";
  return "running";
}
// The usage page passes the browser UI's status words.
export function stateFromLabel(label: string | undefined): SubagentState | null {
  const entry = Object.entries(SUBAGENT_STATUS).find(([, text]) => text === label);
  return entry ? (entry[0] as SubagentState) : null;
}

// What the browser UI counts as a subagent's tokens: new input, cache writes and output.
export const activeTokens = (tokens: SubagentTokens | undefined): number =>
  tokens ? (tokens.inputTokens || 0) + (tokens.cacheCreationTokens || 0) + (tokens.outputTokens || 0) : 0;

// web/usage.js's compactTokens.
export function compactTokens(n: number): string {
  const num = Number(n) || 0;
  if (num <= 0) return "0";
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e7) return `${Math.round(num / 1e6)}M`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e4) return `${Math.round(num / 1e3)}k`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
  return String(Math.round(num));
}
export function tokenText(tokens: SubagentTokens | undefined): string | null {
  const count = activeTokens(tokens);
  return count > 0 ? `${compactTokens(count)} tok` : null;
}

// Drops anything that is not a usable record, so a malformed response cannot break a render.
export function parseRecords(body: unknown): SubagentRecord[] {
  const records = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) return [];
  return records.filter((record): record is SubagentRecord =>
    !!record && typeof record === "object" && typeof record.id === "string" && SUBAGENT_ID_RE.test(record.id) &&
    typeof record.type === "string" && typeof record.startedAt === "string");
}

// Running first, then newest, as renderRelated orders them.
export function sortSubagents(records: readonly SubagentRecord[]): SubagentRecord[] {
  return [...records].sort((a, b) =>
    Number(!!a.endedAt || !!a.stale) - Number(!!b.endedAt || !!b.stale) ||
    (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}
export function visibleSubagents(records: readonly SubagentRecord[], showFinished: boolean): SubagentRecord[] {
  return sortSubagents(records).filter((record) => showFinished || (!record.endedAt && !record.stale));
}

// Whether the server can list this agent's subagents: the browser UI's
// capabilityAvailable(detail, "subagents"). Antigravity has none.
export function subagentsAvailable(detail: { provider?: string; capabilities?: Record<string, unknown> } | null | undefined): boolean {
  if (!detail) return false;
  if (detail.capabilities?.subagents === false) return false;
  return detail.provider !== "antigravity";
}

// The agent id of the AM agent that spawned this one: the browser UI's
// parentKey. A remote child's bare `spawnedBy` means an agent on its own host.
export function parentId(row: Pick<AgentRow, "spawnedBy" | "host">): string | null {
  if (!row.spawnedBy) return null;
  return row.spawnedBy.includes(":") || !row.host ? row.spawnedBy : `${row.host}:${row.spawnedBy}`;
}
export function parentKeyOf(connection: string, row: Pick<AgentRow, "spawnedBy" | "host">): string | null {
  const id = parentId(row);
  return id ? `${connection}/${id}` : null;
}
// AM agents this agent spawned, on the same connection; stopped ones only with showFinished.
export function childRows(connection: string, rows: readonly AgentRow[], key: string, showFinished: boolean): AgentRow[] {
  return rows.filter((row) => parentKeyOf(connection, row) === key && (showFinished || !STOPPED.has(row.status)));
}

// The fleet row's running subagents, with ids am would accept.
export function runningOf(row: Pick<AgentRow, "subagents">): RunningSubagent[] {
  const running = row.subagents?.running;
  if (!Array.isArray(running)) return [];
  return running.filter((item) => !!item && typeof item.id === "string" && SUBAGENT_ID_RE.test(item.id));
}

// Running subagents nest under every row of their parent except the pinned
// "Needs attention" duplicate, right after it, one level deeper and newest
// first. Rows of a collapsed group are not in `items`, so their subagents go
// with them.
export function nestSubagents(items: readonly TreeItem[]): TreeItem[] {
  const out: TreeItem[] = [];
  for (const item of items) {
    out.push(item);
    if (item.kind !== "agent" || item.parent === ATTENTION_GROUP) continue;
    const running = runningOf(item.row).sort((a, b) => (Date.parse(b.startedAt ?? "") || 0) - (Date.parse(a.startedAt ?? "") || 0));
    for (const sub of running) {
      const nested: SubagentItem = {
        kind: "subagent", id: `${item.id}#${sub.id}`, key: subagentKey(item.key, sub.id), agentKey: item.key, subagentId: sub.id,
        label: subagentLabel(sub), startedAt: sub.startedAt ?? "", depth: item.depth + 1, parent: item.id,
      };
      out.push(nested);
    }
  }
  return out;
}

export const itemKey = (item: TreeItem): string | null => (item.kind === "group" ? null : item.key);

// A subagent's status from the best source at hand: its record, the parent's
// fleet row (listed means running), what the opener said, or the transcript
// response (`exited` once it ended). Null when nothing says.
export function resolveState(options: {
  record?: SubagentRecord | null;
  row?: AgentRow | null;
  id: string;
  hint?: SubagentState | null;
  transcriptStatus?: string | null;
}): SubagentState | null {
  if (options.record) return subagentState(options.record, options.row?.status);
  if (options.row && runningOf(options.row).some((item) => item.id === options.id)) return STOPPED.has(options.row.status) ? "stale" : "running";
  if (options.transcriptStatus === "exited") return "finished";
  return options.hint ?? null;
}

export const shouldPoll = (state: SubagentState | null): boolean => state === "running" || state === null;

export const NOT_AVAILABLE = "Output is not available yet. Running Codex subagents may publish their transcript only when they finish.";
