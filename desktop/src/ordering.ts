// Reproduces web/app.js ordering; tests/desktopOrdering.test.ts checks parity against it.
import { rowReasonBeside, rowStatusLabel, statusLabel, STOPPED } from "./fleet";
import type { AgentRow } from "./types";

export const repoPath = (row: Pick<AgentRow, "repoRoot" | "dir">): string => row.repoRoot || row.dir || "";
export const repoName = (row: Pick<AgentRow, "repoRoot" | "dir">): string => repoPath(row).replace(/\/$/, "").split("/").pop() || "—";

// Time in the current working or waiting state, -1 for any other status.
export function runtimeMs(row: Pick<AgentRow, "status" | "statusChangedAt">, now: number): number {
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

export type OverviewFilter = "live" | "attention" | "exited" | "all";
export const OVERVIEW_FILTERS: readonly { id: OverviewFilter; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "attention", label: "Needs attention" },
  { id: "exited", label: "Stopped" },
  { id: "all", label: "All" },
];
export function matchesOverviewFilter(row: Pick<AgentRow, "status">, filter: OverviewFilter): boolean {
  if (filter === "all") return true;
  if (filter === "live") return !STOPPED.has(row.status);
  if (filter === "attention") return row.status === "needs-attention";
  return STOPPED.has(row.status);
}
export function overviewCounts(rows: readonly Pick<AgentRow, "status">[]): Record<OverviewFilter, number> {
  const counts: Record<OverviewFilter, number> = { live: 0, attention: 0, exited: 0, all: 0 };
  for (const row of rows) for (const { id } of OVERVIEW_FILTERS) if (matchesOverviewFilter(row, id)) counts[id]++;
  return counts;
}
// The browser's case-insensitive substring over name, task, host and dir; `extra`
// adds what the app shows that the browser does not (host label, connection name).
export function matchesOverviewQuery(row: Pick<AgentRow, "name" | "task" | "host" | "dir">, query: string, extra: readonly string[] = []): boolean {
  return [row.name, row.task || "", row.host || "", row.dir || "", ...extra].join(" ").toLowerCase().includes(query.toLowerCase());
}

export type OverviewSort = "status" | "repo" | "runtime" | "recent" | "name";
export const OVERVIEW_SORTS: readonly { id: OverviewSort; label: string }[] = [
  { id: "status", label: "Group: Status" },
  { id: "repo", label: "Sort: Repository" },
  { id: "runtime", label: "Sort: Time running" },
  { id: "recent", label: "Sort: Recent activity" },
  { id: "name", label: "Sort: Name" },
];
export interface SortOptions<S extends string> {
  sort: S;
  reverse: boolean;
  now: number;
}
// web/app.js ranks `starting` (and any unknown status) 6, after exited and dead.
const OVERVIEW_RANK: Record<string, number> = { "needs-attention": 0, working: 2, waiting: 2, idle: 3, exited: 4, dead: 5 };
const recency = (a: AgentRow, b: AgentRow) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

// The direction multiplies the whole result, the name tie-break included.
export function compareOverview(a: AgentRow, b: AgentRow, { sort, reverse, now }: SortOptions<OverviewSort>): number {
  let order = 0;
  if (sort === "repo") order = repoName(a).localeCompare(repoName(b)) || repoPath(a).localeCompare(repoPath(b));
  else if (sort === "runtime") order = runtimeMs(b, now) - runtimeMs(a, now);
  else if (sort === "recent") order = recency(a, b);
  else if (sort === "name") order = a.name.localeCompare(b.name);
  else order = (OVERVIEW_RANK[a.status] ?? 6) - (OVERVIEW_RANK[b.status] ?? 6);
  return (order || a.name.localeCompare(b.name)) * (reverse ? -1 : 1);
}

export function statusGroup(status: string): string {
  if (status === "needs-attention") return "Needs attention";
  if (STOPPED.has(status)) return "Stopped";
  return statusLabel(status === "waiting" ? "working" : status);
}

export type SidebarGroup = "tree" | "status" | "repo" | "host";
export const SIDEBAR_GROUPS: readonly { id: SidebarGroup; label: string }[] = [
  { id: "tree", label: "Host & repo" },
  { id: "status", label: "Status" },
  { id: "repo", label: "Repository" },
  { id: "host", label: "Host" },
];
export type SidebarSort = "status" | "recent" | "runtime" | "name";
export const SIDEBAR_SORTS: readonly { id: SidebarSort; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "recent", label: "Recent" },
  { id: "runtime", label: "Runtime" },
  { id: "name", label: "Name" },
];
const SIDEBAR_RANK: Record<string, number> = { "needs-attention": 0, waiting: 1, working: 1, starting: 2, idle: 3 };
export const sidebarRank = (status: string): number => SIDEBAR_RANK[status] ?? 4;

export function compareSidebar(a: AgentRow, b: AgentRow, { sort, reverse, now }: SortOptions<SidebarSort>): number {
  let order = 0;
  if (sort === "recent") order = recency(a, b);
  else if (sort === "runtime") order = runtimeMs(b, now) - runtimeMs(a, now);
  else if (sort === "status") order = sidebarRank(a.status) - sidebarRank(b.status);
  return (order || a.name.localeCompare(b.name)) * (reverse ? -1 : 1);
}

const PROVIDER_LABEL: Record<string, string> = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
export const providerLabel = (provider: string | undefined): string => PROVIDER_LABEL[provider ?? ""] ?? "Unknown";

// The agent id of the row's parent (web/app.js `parentKey`): a bare name on a
// remote host means an agent on that same host.
export function parentId(row: Pick<AgentRow, "spawnedBy" | "host">): string | null {
  if (!row.spawnedBy) return null;
  return row.spawnedBy.includes(":") || !row.host ? row.spawnedBy : `${row.host}:${row.spawnedBy}`;
}

export function sidebarMeta(row: AgentRow, now: number): { status: string; reason: string; queued: string; age: string; prs: string } {
  const updated = Date.parse(row.updatedAt || "");
  const prs = row.prMonitor?.pullRequests ?? [];
  return {
    status: rowStatusLabel(row),
    reason: rowReasonBeside(row, row.statusDetail || row.statusReason || ""),
    queued: row.queued ? `${row.queued} queued` : "",
    age: Number.isFinite(updated) ? `${elapsed(Math.max(0, now - updated))} ago` : "",
    prs: prs.map((pr) => `PR #${pr.number} · ${String(pr.state).toLowerCase()}`).join(", "),
  };
}
