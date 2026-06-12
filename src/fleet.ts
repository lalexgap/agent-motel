import { basename } from "node:path";
import { agentRows, relativeTime, shortenHome, STATUS_COLORS, STATUS_ICONS, type AgentRow } from "./commands/ls";
import { loadConfig } from "./config";
import { sshAm, sshAmAsync, sshRun } from "./remote";
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

export function splitFleetKey(key: string): { host?: string; name: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { name: key };
  return { host: key.slice(0, idx), name: key.slice(idx + 1) };
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

interface CacheEntry {
  rows: FleetRow[];
  fetchedAt: number;
  inFlight: boolean;
  ok: boolean;
}

const cache = new Map<string, CacheEntry>();

function refreshHost(host: string): void {
  const entry = cache.get(host);
  if (entry?.inFlight) return;
  if (entry && Date.now() - entry.fetchedAt < REMOTE_REFRESH_MS) return;
  cache.set(host, {
    rows: entry?.rows ?? [],
    fetchedAt: entry?.fetchedAt ?? 0,
    ok: entry?.ok ?? false,
    inFlight: true,
  });
  sshAmAsync(host, ["ls", "--json", "--local-only"]).then(
    (result) => {
      const rows = result.exitCode === 0 ? parseRows(host, result.stdout) : null;
      const prev = cache.get(host);
      cache.set(host, {
        rows: rows ?? prev?.rows ?? [],
        fetchedAt: Date.now(),
        ok: rows !== null,
        inFlight: false,
      });
    },
    () => {
      cache.set(host, { rows: [], fetchedAt: Date.now(), ok: false, inFlight: false });
    },
  );
}

export function cachedFleetRows(): Fleet {
  const rows: FleetRow[] = agentRows();
  const unreachable: string[] = [];
  for (const host of loadConfig().remotes ?? []) {
    const entry = cache.get(host);
    if (entry?.ok) rows.push(...entry.rows);
    else if (entry && !entry.inFlight) unreachable.push(host);
    refreshHost(host);
  }
  return { rows, unreachable };
}

// Last-screen preview of a remote agent, cached so the hub's render loop
// never stacks ssh round-trips.
const PREVIEW_REFRESH_MS = 2000;
const previewCache = new Map<string, { lines: string[] | null; fetchedAt: number; inFlight: boolean }>();

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
let groupMode: GroupMode = "host";

export function toggleGroupMode(): GroupMode {
  groupMode = groupMode === "host" ? "dir" : "host";
  return groupMode;
}

export function sectionFor(row: FleetRow, mode: GroupMode): string {
  // Project = basename, not path: the same repo legitimately lives at
  // different paths per machine (~ vs /home/u vs a /mnt symlink target), and
  // any path-string normalization would still split those into separate
  // sections.
  if (mode === "dir") return basename(row.repoRoot ?? row.dir);
  return row.host ?? "local";
}

// Shared list builder for the classic picker and the hub sidebar: one item
// per agent across the whole fleet, keyed host:name for remote rows.
export function fleetPickerItems(): PickerItem[] {
  const { rows, unreachable } = cachedFleetRows();
  // Groups must be contiguous for the picker's section headers; host mode is
  // naturally ordered (local rows come first), dir mode needs the sort.
  const sorted = groupMode === "dir" ? [...rows].sort((a, b) => sectionFor(a, "dir").localeCompare(sectionFor(b, "dir"))) : rows;
  const items = sorted.map((r) => {
    const hostBadge = r.host ? `@${shortHost(r.host)}` : "";
    // The colored glyph carries the status, so the badge drops the redundant
    // status word and keeps only host/provider/queue. Queue stands out: a
    // compact ▸N, yellow when backed up.
    const queueBadge = r.queued > 0 ? `▸${r.queued}` : "";
    return {
      name: fleetKey(r),
      section: sectionFor(r, groupMode),
      secondary: r.status === "exited",
      icon: STATUS_ICONS[r.status],
      iconStyle: STATUS_COLORS[r.status],
      label: r.name,
      right: [hostBadge, r.provider === "codex" ? "codex" : "", queueBadge].filter(Boolean).join(" "),
      rightStyle: r.queued > 0 ? "\x1b[33m" : "\x1b[2m", // yellow when queued, else dim
      search: `${r.task ?? ""} ${shortenHome(r.dir)} ${r.provider} ${r.host ?? "local"}`,
      meta: [
        `status   ${r.status}${r.statusDetail ? ` — ${r.statusDetail}` : ""}${r.queued > 0 ? ` (${r.queued} queued)` : ""}`,
        `host     ${r.host ?? "local"}`,
        `provider ${r.provider}`,
        `dir      ${shortenHome(r.dir)}`,
        ...(r.worktreeBranch ? [`branch   ${r.worktreeBranch}`] : []),
        ...(r.reportTo ? [`reports  → ${r.reportTo}`] : []),
        ...(r.task ? [`task     ${r.task}`] : []),
        `updated  ${relativeTime(r.updatedAt)}`,
        ...(r.createdAt ? [`created  ${relativeTime(r.createdAt)}`] : []),
      ],
    };
  });
  for (const host of unreachable) {
    items.push({
      name: `${host}:`,
      section: host,
      secondary: false,
      icon: "✕",
      iconStyle: "\x1b[31;2m", // dim red
      label: `(${shortHost(host)} unreachable)`,
      right: "",
      rightStyle: "\x1b[2m",
      search: host,
      meta: [`host     ${host}`, `status   unreachable`],
    });
  }
  return items;
}

// Find a remote row in the cache (fresh enough for routing decisions).
export function cachedRemoteRow(host: string, name: string): FleetRow | null {
  return cache.get(host)?.rows.find((r) => r.name === name) ?? null;
}

export { sshRun };
