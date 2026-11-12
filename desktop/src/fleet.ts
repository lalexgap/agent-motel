// Pure sidebar model: agent keys, sorting, filtering and the grouped tree the
// sidebar renders and the keyboard walks. No DOM here so it is unit-testable.
import { compareSidebar, repoName, type SidebarGroup, type SidebarSort } from "./ordering";
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
  // The id GET /api/concierge named (`concierge` or `host:concierge`), or null when unknown.
  conciergeKey?: string | null;
}

const roleName = (row: AgentRow): string => (typeof row.role === "string" ? row.role : row.role?.name ?? "");

// The concierge's agent id on a connection: the row the server named, else
// (older server, failed request, stale key) the row whose role says so.
export function conciergeId(fleet: Pick<ConnectionFleet, "rows" | "conciergeKey">): string | null {
  if (fleet.conciergeKey && fleet.rows.some((row) => agentId(row) === fleet.conciergeKey)) return fleet.conciergeKey;
  const byRole = fleet.rows.find((row) => roleName(row) === "concierge");
  return byRole ? agentId(byRole) : null;
}
export function conciergeRow(fleet: Pick<ConnectionFleet, "rows" | "conciergeKey">): AgentRow | null {
  const id = conciergeId(fleet);
  return id === null ? null : fleet.rows.find((row) => agentId(row) === id) ?? null;
}
// Every agent but the concierge: what the lists and counts are about.
export function fleetRows(fleet: Pick<ConnectionFleet, "rows" | "conciergeKey">): AgentRow[] {
  const id = conciergeId(fleet);
  return id === null ? fleet.rows : fleet.rows.filter((row) => agentId(row) !== id);
}
export function isConciergeKey(fleets: readonly ConnectionFleet[], key: string): boolean {
  const parsed = parseAgentKey(key);
  const fleet = parsed && fleets.find((candidate) => candidate.id === parsed.connection);
  return !!fleet && conciergeId(fleet) === parsed.id;
}
// What `c` opens: the concierge of the open agent's connection, else the first one there is.
export function conciergeTarget(fleets: readonly ConnectionFleet[], openKey: string | null): string | null {
  const connection = openKey ? parseAgentKey(openKey)?.connection : undefined;
  const ordered = [...fleets.filter((fleet) => fleet.id === connection), ...fleets.filter((fleet) => fleet.id !== connection)];
  for (const fleet of ordered) {
    const row = conciergeRow(fleet);
    if (row) return agentKey(fleet.id, row);
  }
  return null;
}

export interface TreeOptions {
  filter: string;
  showStopped: boolean;
  collapsed: ReadonlySet<string>;
  // How rows are grouped and ordered; the default is the nested layout sorted by status.
  group?: SidebarGroup;
  sort?: SidebarSort;
  reverse?: boolean;
  now?: number;
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
  // The pinned concierge entry, labelled with `connectionName` when there are several connections.
  concierge?: boolean;
  connectionName?: string;
}
export type TreeItem = GroupItem | AgentItem;

export interface TreeModel {
  items: TreeItem[];
  hiddenStopped: number;
  shown: number;
  total: number;
}

export const ATTENTION_GROUP = "attention";
// The parent of every row in the flat Status list, which has no group rows.
export const LIST_GROUP = "list";
export const CONCIERGE_SECTION = "concierge";
export const isPinnedConcierge = (item: TreeItem): item is AgentItem => item.kind === "agent" && !!item.concierge;

// The flat, visible tree: the pinned concierge entries, then groups plus the
// agents of expanded groups, in render order. The same agent may appear twice
// (pinned "Needs attention" and its repository); item ids differ, agent keys
// do not. The concierge appears only in its own entry and in no count.
export function buildTree(fleets: ConnectionFleet[], options: TreeOptions): TreeModel {
  const items: TreeItem[] = [];
  const filtering = options.filter.trim() !== "";
  // A filter shows every match, even inside collapsed groups.
  const isCollapsed = (id: string) => !filtering && options.collapsed.has(id);
  const multi = fleets.length > 1;
  let hiddenStopped = 0, total = 0;
  // Pinned regardless of the filter and of "Show stopped".
  for (const fleet of fleets) {
    const row = conciergeRow(fleet);
    if (!row) continue;
    const key = agentKey(fleet.id, row);
    items.push({
      kind: "agent", id: `${CONCIERGE_SECTION}>${key}`, key, connection: fleet.id, row, depth: 0, parent: CONCIERGE_SECTION,
      hostLabel: row.host || fleet.local, concierge: true, ...(multi ? { connectionName: fleet.name } : {}),
    });
  }
  const visible: { fleet: ConnectionFleet; row: AgentRow }[] = [];
  const regular = new Map(fleets.map((fleet) => [fleet, fleetRows(fleet)]));
  for (const fleet of fleets) for (const row of regular.get(fleet)!) {
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

  const group = options.group ?? "tree";
  const order = { sort: options.sort ?? "status", reverse: options.reverse ?? false, now: options.now ?? Date.now() } as const;
  const byOrder = (a: { row: AgentRow }, b: { row: AgentRow }) => compareSidebar(a.row, b.row, order);

  // The flat Status list already puts agents that need you first, so it has no separate section.
  const attention = group === "status" ? [] : visible.filter(({ row }) => row.status === "needs-attention").sort(byOrder);
  if (attention.length) {
    const collapsed = isCollapsed(ATTENTION_GROUP);
    items.push({ kind: "group", id: ATTENTION_GROUP, label: "Needs attention", depth: 0, count: attention.length, collapsed, parent: null, tone: "attention" });
    if (!collapsed) for (const { fleet, row } of attention) items.push(agentItem(fleet, row, ATTENTION_GROUP, 1));
  }

  if (group === "status") {
    for (const { fleet, row } of [...visible].sort(byOrder)) items.push(agentItem(fleet, row, LIST_GROUP, 0));
    return { items, hiddenStopped, shown: visible.length, total };
  }
  if (group === "repo" || group === "host") {
    // One level of groups ordered by label, as in the browser UI's sidebar.
    type Bucket = { label: string; tone: "repo" | "host"; marker?: string; entries: typeof visible };
    const buckets = new Map<string, Bucket>();
    const bucket = (id: string, label: string, tone: Bucket["tone"], marker?: string): Bucket => {
      let entry = buckets.get(id);
      if (!entry) buckets.set(id, entry = { label, tone, marker, entries: [] });
      return entry;
    };
    const hostLabel = (fleet: ConnectionFleet, host: string) => (host || fleet.local || "This server") + (multi ? ` · ${fleet.name}` : "");
    const hostBucket = (fleet: ConnectionFleet, host: string) =>
      bucket(`g:host:${fleet.id}:${host}`, hostLabel(fleet, host), "host", host && fleet.unreachable.includes(host) ? "unreachable" : undefined);
    if (group === "host" && !filtering) for (const fleet of fleets) for (const host of fleet.unreachable) hostBucket(fleet, host);
    for (const entry of visible) {
      const target = group === "repo" ? bucket(`g:repo:${repoName(entry.row)}`, repoName(entry.row), "repo") : hostBucket(entry.fleet, entry.row.host || "");
      target.entries.push(entry);
    }
    for (const [id, entry] of [...buckets].sort(([, a], [, b]) => a.label.localeCompare(b.label))) {
      const collapsed = isCollapsed(id);
      items.push({ kind: "group", id, label: entry.label, depth: 0, count: entry.entries.length, collapsed, parent: null, tone: entry.tone, marker: entry.marker });
      if (!collapsed) for (const { fleet, row } of entry.entries.sort(byOrder)) items.push(agentItem(fleet, row, id, 1));
    }
    return { items, hiddenStopped, shown: visible.length, total };
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
    for (const row of regular.get(fleet)!) if (row.host) remotes.add(row.host);
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
        const repoRows = (repos.get(label) || []).sort((a, b) => compareSidebar(a, b, order));
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

export function moveCursor(items: readonly TreeItem[], current: string | null, delta: number): string | null {
  if (!items.length) return null;
  const index = current ? items.findIndex((item) => item.id === current) : -1;
  if (index < 0) return (delta > 0 ? items[0] : items[items.length - 1])!.id;
  return items[Math.max(0, Math.min(items.length - 1, index + delta))]!.id;
}
