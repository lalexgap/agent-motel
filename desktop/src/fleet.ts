// Pure sidebar model: agent keys, sorting, filtering and the grouped tree the
// sidebar renders and the keyboard walks. No DOM here so it is unit-testable.
import type { AgentRow, AgentStatus } from "./types";

// `host:name` for remote agents, plain `name` on the server's own machine.
export const agentId = (row: Pick<AgentRow, "name" | "host">): string => (row.host ? `${row.host}:${row.name}` : row.name);
export const agentKey = (connection: string, row: Pick<AgentRow, "name" | "host">): string => `${connection}/${agentId(row)}`;
export function parseAgentKey(key: string): { connection: string; id: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { connection: key.slice(0, slash), id: key.slice(slash + 1) };
}
export const agentPath = (id: string): string => "/api/agents/" + encodeURIComponent(id);

export const STOPPED: ReadonlySet<string> = new Set(["exited", "dead"]);
export const BUSY: ReadonlySet<string> = new Set(["working", "starting", "waiting"]);
const RANK: Record<string, number> = { "needs-attention": 0, working: 1, waiting: 2, starting: 3, idle: 4, exited: 5, dead: 5 };
export const statusRank = (status: string): number => RANK[status] ?? 6;

export function compareRows(a: AgentRow, b: AgentRow): number {
  return statusRank(a.status) - statusRank(b.status) ||
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
    a.name.localeCompare(b.name);
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  "needs-attention": "Needs attention",
  waiting: "Waiting on background tasks",
  dead: "Offline",
  exited: "Exited",
  starting: "Starting",
};
// Short text so status is never carried by colour alone in a narrow row.
export const STATUS_SHORT: Record<AgentStatus, string> = {
  working: "working",
  idle: "idle",
  "needs-attention": "needs you",
  waiting: "waiting",
  dead: "offline",
  exited: "exited",
  starting: "starting",
};
export const statusLabel = (status: string): string => STATUS_LABEL[status as AgentStatus] ?? status;
export const statusShort = (status: string): string => STATUS_SHORT[status as AgentStatus] ?? status;

const basename = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;
const HOME_DIR = /^(~|\/home\/[^/]+|\/Users\/[^/]+|\/root|\/var\/root)\/?$/;
export const NO_REPO = "No repository";
export function repoLabel(row: Pick<AgentRow, "repoRoot" | "dir">): string {
  if (row.repoRoot) return basename(row.repoRoot);
  if (!row.dir || HOME_DIR.test(row.dir)) return NO_REPO;
  return basename(row.dir);
}

export function matchesFilter(row: AgentRow, query: string, hostLabel = ""): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [row.name, row.host || hostLabel, repoLabel(row), row.worktreeBranch, row.provider, row.model, row.status, statusLabel(row.status)]
    .filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export interface ConnectionFleet {
  id: string;
  name: string;
  local: string;
  rows: AgentRow[];
  remoteHosts: string[];
  unreachable: string[];
}

export interface TreeOptions {
  filter: string;
  showStopped: boolean;
  collapsed: ReadonlySet<string>;
}

export interface GroupItem {
  kind: "group";
  id: string;
  label: string;
  depth: number;
  count: number;
  collapsed: boolean;
  parent: string | null;
  tone?: "attention" | "connection" | "host" | "repo";
  marker?: string;
}
export interface AgentItem {
  kind: "agent";
  id: string;
  key: string;
  connection: string;
  row: AgentRow;
  depth: number;
  parent: string;
  hostLabel: string;
}
export type TreeItem = GroupItem | AgentItem;

export interface TreeModel {
  items: TreeItem[];
  hiddenStopped: number;
  shown: number;
  total: number;
}

export const ATTENTION_GROUP = "attention";

// The flat, visible tree: groups plus the agents of expanded groups, in render
// order. The same agent may appear twice (pinned "Needs attention" and its
// repository); item ids differ, agent keys do not.
export function buildTree(fleets: ConnectionFleet[], options: TreeOptions): TreeModel {
  const items: TreeItem[] = [];
  const filtering = options.filter.trim() !== "";
  // A filter shows every match, even inside collapsed groups.
  const isCollapsed = (id: string) => !filtering && options.collapsed.has(id);
  const multi = fleets.length > 1;
  let hiddenStopped = 0, total = 0;
  const visible: { fleet: ConnectionFleet; row: AgentRow }[] = [];
  for (const fleet of fleets) for (const row of fleet.rows) {
    total++;
    if (STOPPED.has(row.status) && !options.showStopped) { hiddenStopped++; continue; }
    if (!matchesFilter(row, options.filter, fleet.local)) continue;
    visible.push({ fleet, row });
  }
  const agentItem = (fleet: ConnectionFleet, row: AgentRow, parent: string, depth: number): AgentItem => ({
    kind: "agent",
    id: `${parent}>${agentKey(fleet.id, row)}`,
    key: agentKey(fleet.id, row),
    connection: fleet.id,
    row,
    depth,
    parent,
    hostLabel: row.host || fleet.local,
  });

  const attention = visible.filter(({ row }) => row.status === "needs-attention")
    .sort((a, b) => compareRows(a.row, b.row));
  if (attention.length) {
    const collapsed = isCollapsed(ATTENTION_GROUP);
    items.push({ kind: "group", id: ATTENTION_GROUP, label: "Needs attention", depth: 0, count: attention.length, collapsed, parent: null, tone: "attention" });
    if (!collapsed) for (const { fleet, row } of attention) items.push(agentItem(fleet, row, ATTENTION_GROUP, 1));
  }

  for (const fleet of fleets) {
    const rows = visible.filter((entry) => entry.fleet === fleet).map((entry) => entry.row);
    const connectionId = `c:${fleet.id}`;
    let base = 0;
    let connectionCollapsed = false;
    if (multi) {
      if (filtering && !rows.length) continue;
      connectionCollapsed = isCollapsed(connectionId);
      items.push({ kind: "group", id: connectionId, label: fleet.name, depth: 0, count: rows.length, collapsed: connectionCollapsed, parent: null, tone: "connection" });
      base = 1;
      if (connectionCollapsed) continue;
    }
    const hosts: string[] = [""];
    const remotes = new Set<string>(fleet.remoteHosts);
    for (const row of fleet.rows) if (row.host) remotes.add(row.host);
    hosts.push(...[...remotes].sort((a, b) => a.localeCompare(b)));
    for (const host of hosts) {
      const hostRows = rows.filter((row) => (row.host || "") === host);
      const unreachable = host !== "" && fleet.unreachable.includes(host);
      if (!hostRows.length && (filtering || !unreachable)) continue;
      const hostId = `h:${fleet.id}:${host}`;
      const hostCollapsed = isCollapsed(hostId);
      items.push({
        kind: "group", id: hostId, label: host || fleet.local || "This server", depth: base, count: hostRows.length,
        collapsed: hostCollapsed, parent: multi ? connectionId : null, tone: "host", marker: unreachable ? "unreachable" : undefined,
      });
      if (hostCollapsed) continue;
      const repos = new Map<string, AgentRow[]>();
      for (const row of hostRows) {
        const label = repoLabel(row);
        repos.set(label, [...(repos.get(label) || []), row]);
      }
      const labels = [...repos.keys()].sort((a, b) =>
        Number(a === NO_REPO) - Number(b === NO_REPO) || a.localeCompare(b));
      for (const label of labels) {
        const repoRows = (repos.get(label) || []).sort(compareRows);
        const repoId = `r:${fleet.id}:${host}:${label}`;
        const repoCollapsed = isCollapsed(repoId);
        items.push({ kind: "group", id: repoId, label, depth: base + 1, count: repoRows.length, collapsed: repoCollapsed, parent: hostId, tone: "repo" });
        if (!repoCollapsed) for (const row of repoRows) items.push(agentItem(fleet, row, repoId, base + 2));
      }
    }
  }
  return { items, hiddenStopped, shown: visible.length, total };
}

export type StatusCounts = Record<AgentStatus, number>;
export function countStatuses(rows: Iterable<AgentRow>): StatusCounts {
  const counts: StatusCounts = { "needs-attention": 0, working: 0, waiting: 0, starting: 0, idle: 0, exited: 0, dead: 0 };
  for (const row of rows) if (row.status in counts) counts[row.status]++;
  return counts;
}

// Keyboard movement over the flat visible list.
export function moveCursor(items: readonly TreeItem[], current: string | null, delta: number): string | null {
  if (!items.length) return null;
  const index = current ? items.findIndex((item) => item.id === current) : -1;
  if (index < 0) return (delta > 0 ? items[0] : items[items.length - 1])!.id;
  return items[Math.max(0, Math.min(items.length - 1, index + delta))]!.id;
}
