import { basename } from "node:path";
import { agentRows, cachedGitDiffSummary, relativeTime, shortenHome, STATUS_COLORS, STATUS_ICONS, type AgentRow } from "./commands/ls";
import { loadConfig } from "./config";
import { sshAm, sshAmAsync, sshRun } from "./remote";
import { splitAddr } from "./comms";
import type { PickerItem } from "./picker";

// The merged local+remote fleet. Remote rows come from `am ls --json
// --local-only` over ssh (--local-only so a server with remotes configured
// can't recurse back at us).

export interface FleetRow extends AgentRow {
  host?: string; // undefined = local
}

export interface Fleet {
  rows: FleetRow[];
  unreachable: string[];
}

export function fleetKey(row: { host?: string; name: string }): string {
  return row.host ? `${row.host}:${row.name}` : row.name;
}

// Delegates to the canonical address parser (colon-primary, tolerant of the
// legacy name@host form) so reply routing and attribution agree everywhere.
export function splitFleetKey(key: string): { host?: string; name: string } {
  return splitAddr(key);
}

// Hosts can be long ("home.alexgap.ca"); badges and columns use the first
// dns label.
export function shortHost(host: string): string {
  return host.split(".")[0] || host;
}

function parseRows(host: string, stdout: string): FleetRow[] | null {
  try {
    return (JSON.parse(stdout) as AgentRow[]).map((row) => ({ ...row, host }));
  } catch {
    return null;
  }
}

function fetchRemoteRows(host: string, timeoutMs: number): FleetRow[] | null {
  const result = sshAm(host, ["ls", "--json", "--local-only"], { timeoutMs });
  if (result.exitCode !== 0) return null;
  return parseRows(host, result.stdout);
}

// Synchronous merge for one-shot consumers (`am ls`). An unreachable host is
// reported, never thrown — a dead server must not break the local view.
export function fleetRows(opts: { localOnly?: boolean; timeoutMs?: number } = {}): Fleet {
  const rows: FleetRow[] = agentRows();
  const unreachable: string[] = [];
  if (!opts.localOnly) {
    for (const host of loadConfig().remotes ?? []) {
      const remote = fetchRemoteRows(host, opts.timeoutMs ?? 5000);
      if (remote) rows.push(...remote);
      else unreachable.push(host);
    }
  }
  return { rows, unreachable };
}

// Async cache for the picker/hub, whose load() runs every second and must
// never block on ssh: returns local rows + the last-known remote rows
// instantly, refreshing each host in the background at most every few
// seconds.
const REMOTE_REFRESH_MS = 5000;
// A host keeps rendering its last-known rows for this long after its last
// successful fetch, so one ssh blip doesn't blank it from the hub; past the
// grace it reads as unreachable (rows stay cached for routing lookups).
const REMOTE_STALE_GRACE_MS = 30_000;

interface CacheEntry {
  rows: FleetRow[];
  fetchedAt: number;
  inFlight: boolean;
  okAt: number; // last successful fetch (0 = never)
}

const cache = new Map<string, CacheEntry>();

function refreshHost(host: string): void {
  const entry = cache.get(host);
  if (entry?.inFlight) return;
  if (entry && Date.now() - entry.fetchedAt < REMOTE_REFRESH_MS) return;
  cache.set(host, {
    rows: entry?.rows ?? [],
    fetchedAt: entry?.fetchedAt ?? 0,
    okAt: entry?.okAt ?? 0,
    inFlight: true,
  });
  sshAmAsync(host, ["ls", "--json", "--local-only"]).then(
    (result) => {
      const rows = result.exitCode === 0 ? parseRows(host, result.stdout) : null;
      const prev = cache.get(host);
      cache.set(host, {
        rows: rows ?? prev?.rows ?? [],
        fetchedAt: Date.now(),
        okAt: rows !== null ? Date.now() : (prev?.okAt ?? 0),
        inFlight: false,
      });
    },
    () => {
      const prev = cache.get(host);
      cache.set(host, {
        rows: prev?.rows ?? [],
        fetchedAt: Date.now(),
        okAt: prev?.okAt ?? 0,
        inFlight: false,
      });
    },
  );
}

export function cachedFleetRows(): Fleet {
  const rows: FleetRow[] = agentRows();
  const unreachable: string[] = [];
  for (const host of loadConfig().remotes ?? []) {
    const entry = cache.get(host);
    if (entry && entry.okAt > 0 && Date.now() - entry.okAt < REMOTE_STALE_GRACE_MS) {
      rows.push(...entry.rows);
    } else if (entry && !entry.inFlight) {
      unreachable.push(host);
    }
    refreshHost(host);
  }
  return { rows, unreachable };
}

// Last-screen preview of a remote agent, cached so the hub's render loop
// never stacks ssh round-trips.
const PREVIEW_REFRESH_MS = 2000;
const previewCache = new Map<string, { lines: string[] | null; fetchedAt: number; inFlight: boolean }>();

// Apply a successful remote rename immediately instead of leaving the picker
// on the stale old row until its next SSH refresh.
export function renameCachedRemoteAgent(host: string, oldName: string, newName: string): void {
  const entry = cache.get(host);
  if (entry) {
    entry.rows = entry.rows.map((row) => row.name === oldName
      ? {
          ...row,
          name: newName,
          aliases: [...new Set([...(row.aliases ?? []).filter((alias) => alias !== newName), oldName])],
        }
      : row);
    entry.fetchedAt = 0;
  }
  const oldKey = `${host}:${oldName}`;
  const preview = previewCache.get(oldKey);
  if (preview) {
    previewCache.set(`${host}:${newName}`, preview);
    previewCache.delete(oldKey);
  }
}

export function cachedRemotePreview(host: string, agentName: string): string[] | null {
  const key = `${host}:${agentName}`;
  const entry = previewCache.get(key);
  if (!entry || (!entry.inFlight && Date.now() - entry.fetchedAt >= PREVIEW_REFRESH_MS)) {
    previewCache.set(key, {
      lines: entry?.lines ?? null,
      fetchedAt: entry?.fetchedAt ?? 0,
      inFlight: true,
    });
    void refreshPreview(key, host, agentName);
  }
  return previewCache.get(key)?.lines ?? null;
}

async function refreshPreview(key: string, host: string, agentName: string): Promise<void> {
  try {
    // Raw tmux over ssh (no login shell needed): capture the agent's pane.
    const proc = Bun.spawn(["ssh", host, "--", `tmux capture-pane -p -e -t '=agentmgr-${agentName}:'`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const lines = exitCode === 0 ? stdout.replace(/\n+$/, "").split("\n") : null;
    previewCache.set(key, { lines, fetchedAt: Date.now(), inFlight: false });
  } catch {
    previewCache.set(key, { lines: null, fetchedAt: Date.now(), inFlight: false });
  }
}

// Sidebar grouping: by host (local first, then each remote) or by project
// (repoRoot when the agent lives in a worktree — grouping by the literal
// worktree dir would put every agent alone — else its dir). Toggled with
// `g`; session-local.
export type GroupMode = "host" | "dir";
export type SortMode = "status" | "recent";
let groupMode: GroupMode = "host";
let sortMode: SortMode = "status";

export function toggleGroupMode(): GroupMode {
  groupMode = groupMode === "host" ? "dir" : "host";
  return groupMode;
}

export function toggleSortMode(): SortMode {
  sortMode = sortMode === "status" ? "recent" : "status";
  return sortMode;
}

export function sectionFor(row: FleetRow, mode: GroupMode): string {
  // Project = basename, not path: the same repo legitimately lives at
  // different paths per machine (~ vs /home/u vs a /mnt symlink target), and
  // any path-string normalization would still split those into separate
  // sections.
  if (mode === "dir") return basename(row.repoRoot ?? row.dir);
  return row.host ?? "local";
}

const STATUS_PRIORITY: Record<AgentRow["status"], number> = {
  "needs-attention": 0,
  working: 1,
  waiting: 2,
  starting: 3,
  idle: 4,
  exited: 5,
  dead: 6,
};

function activityTime(row: FleetRow): number {
  const time = Date.parse(row.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

export function sortFleetRows(rows: FleetRow[], mode: GroupMode, sort: SortMode = "status"): FleetRow[] {
  const sectionOrder = new Map<string, number>();
  if (mode === "host") {
    for (const row of rows) {
      const section = sectionFor(row, mode);
      if (!sectionOrder.has(section)) sectionOrder.set(section, sectionOrder.size);
    }
  }
  return [...rows].sort((a, b) => {
    const sectionA = sectionFor(a, mode);
    const sectionB = sectionFor(b, mode);
    const sectionCmp = mode === "dir"
      ? sectionA.localeCompare(sectionB)
      : (sectionOrder.get(sectionA) ?? 0) - (sectionOrder.get(sectionB) ?? 0);
    if (sectionCmp) return sectionCmp;
    if (sort === "recent") {
      return activityTime(b) - activityTime(a)
        || STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
        || fleetKey(a).localeCompare(fleetKey(b));
    }
    return STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name);
  });
}

const FG = "\x1b[38;2;169;177;214m";
const GREEN = "\x1b[38;2;158;206;106m";
const RED = "\x1b[38;2;247;118;142m";
const AMBER = "\x1b[38;2;224;175;104m";
const MUTED = "\x1b[38;2;86;95;137m";
// Provider tags are plain colored text per the TUI design: claude keeps its
// purple, codex is muted and brightens to blue on the selection fill.
const BLUE = "\x1b[38;2;122;162;247m";
const PURPLE = "\x1b[38;2;187;154;247m";

function compactAge(iso: string): string {
  return relativeTime(iso).replace(/ ago$/, "");
}

function activityFor(row: FleetRow): string {
  if (row.status === "needs-attention") return "needs you";
  // The dimmed row already says "idle"; the age alone keeps columns tight.
  return compactAge(row.updatedAt);
}

function detailStatus(status: AgentRow["status"]): string {
  if (status === "needs-attention") return "needs you";
  if (status === "working" || status === "starting") return "running";
  return status;
}

function diffDetail(row: FleetRow): string {
  // null = the dir isn't a git checkout; undefined on a remote row = the
  // remote am predates diff-in-ls and will never fill it in.
  if (row.diff === null) return "—";
  if (!row.diff) return !row.host && row.status !== "exited" ? `${MUTED}checking…${FG}` : "—";
  if (!row.diff.dirty) return `${GREEN}clean${FG}`;
  const files = `${row.diff.files} ${row.diff.files === 1 ? "file" : "files"}`;
  return `${GREEN}+${row.diff.added}${FG} ${RED}−${row.diff.removed}${FG} · ${files}`;
}

// Shared list builder for the classic picker and the hub sidebar: one item
// per agent across the whole fleet, keyed host:name for remote rows.
export function fleetPickerItems(): PickerItem[] {
  const { rows, unreachable } = cachedFleetRows();
  // Local active agents get live diffs from the non-blocking cache — any dir
  // is worth probing (in-place repo agents count, not just worktrees; a
  // non-repo dir caches null and is never probed again). Remote rows carry
  // whatever diff their host's `am ls --json` computed.
  const withDiff = rows.map((row) =>
    !row.host && row.status !== "exited" && row.diff === undefined
      ? { ...row, diff: cachedGitDiffSummary(row.dir) }
      : row,
  );
  const sorted = sortFleetRows(withDiff, groupMode, sortMode);
  const items: PickerItem[] = sorted.map((r) => {
    return {
      name: fleetKey(r),
      section: sectionFor(r, groupMode),
      secondary: r.status === "exited",
      icon: STATUS_ICONS[r.status],
      iconStyle: STATUS_COLORS[r.status],
      status: r.status,
      statusLabel: detailStatus(r.status),
      label: r.name,
      labelStyle: r.status === "needs-attention" ? AMBER : r.status === "idle" ? MUTED : FG,
      right: activityFor(r),
      rightStyle: r.status === "needs-attention" ? AMBER : MUTED,
      badge: r.provider === "codex" ? "cdx" : "cld",
      badgeStyle: r.provider === "codex" ? MUTED : PURPLE,
      badgeSelectedStyle: r.provider === "codex" ? BLUE : PURPLE,
      queueDepth: r.queued,
      search: `${r.task ?? ""} ${shortenHome(r.dir)} ${r.provider} ${r.host ?? "local"}`,
      meta: [
        `host     ${r.host ?? "local"}`,
        `provider ${r.provider}`,
        r.worktreeBranch ? `branch   ${r.worktreeBranch}` : `dir      ${shortenHome(r.dir)}`,
        `diff     ${diffDetail(r)}`,
        `updated  ${relativeTime(r.updatedAt)}${r.diff?.dirty ? ` ${MUTED}· uncommitted${FG}` : ""}`,
      ],
    };
  });
  for (const host of unreachable) {
    items.push({
      name: `${host}:`,
      section: host,
      secondary: false,
      icon: "✕",
      iconStyle: STATUS_COLORS.dead,
      status: "dead",
      statusLabel: "unreachable",
      label: `(${shortHost(host)} unreachable)`,
      right: "",
      rightStyle: MUTED,
      search: host,
      meta: [`host     ${host}`, "provider —", "dir      —", "diff     —", "updated  —"],
    });
  }
  return items;
}

// Find a remote row in the cache (fresh enough for routing decisions).
export function cachedRemoteRow(host: string, name: string): FleetRow | null {
  return cache.get(host)?.rows.find((r) => r.name === name) ?? null;
}

export { sshRun };
