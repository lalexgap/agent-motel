import { basename } from "node:path";
import { agentRows, cachedGitDiffSummary, relativeTime, shortenHome, STATUS_COLORS, STATUS_ICONS, type AgentRow } from "./commands/ls";
import { CONCIERGE_NAME } from "./providers";
import { loadConfig, shortHost } from "./config";
import { sshAm, sshAmAsync, sshRun, sshRunAsync } from "./remote";
import { watchRemoteFleetEvents } from "./fleetEvents";
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
// With a live event stream from the host (see startFleetEventWatch), polling
// is only a consistency net — relax it. Aging okAt past the stale grace is
// fine here, because a healthy stream itself counts as reachability (see
// hostRenderState); the grace only governs hosts on the tight poll, where
// two windows plus a fetch timeout fit inside it.
const REMOTE_REFRESH_STREAMING_MS = 15_000;
// A host keeps rendering its last-known rows for this long after its last
// successful fetch, so one ssh blip doesn't blank it from the hub; past the
// grace it reads as unreachable (rows stay cached for routing lookups).
const REMOTE_STALE_GRACE_MS = 30_000;
// Background fetches must never wedge the cache: an unbounded ssh (host
// thrashing, dead route) used to leave inFlight set forever, silently
// freezing that host's rows until "unreachable". Generous vs the one-shot
// `am ls` 5s, since nothing here blocks a render on it.
const REMOTE_FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  rows: FleetRow[];
  fetchedAt: number;
  inFlight: Promise<void> | null;
  okAt: number; // last successful fetch (0 = never)
}

const cache = new Map<string, CacheEntry>();

// Renderers of the cache (hub sidebar, api server) subscribe to hear when a
// background fetch actually changed rows — that's what turns a push or poll
// result into an immediate repaint instead of waiting out the next tick.
const cacheListeners = new Set<() => void>();

export function subscribeFleetCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

function notifyCacheChanged(): void {
  for (const listener of cacheListeners) {
    try {
      listener();
    } catch {
      // a broken listener must not stall the fetch path
    }
  }
}

// Per-host push-channel health, set by the event watcher: a healthy host
// polls on the relaxed cadence, since push carries the urgency.
const streamHealth = new Map<string, boolean>();

function refreshWindowMs(host: string): number {
  return streamHealth.get(host) ? REMOTE_REFRESH_STREAMING_MS : REMOTE_REFRESH_MS;
}

// The ssh fetch behind refreshHost — the one seam tests can't reach through
// a real ssh, so it is swappable.
async function fetchRowsOverSsh(host: string): Promise<FleetRow[] | null> {
  try {
    const result = await sshAmAsync(host, ["ls", "--json", "--local-only"], {
      timeoutMs: REMOTE_FETCH_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? parseRows(host, result.stdout) : null;
  } catch {
    return null;
  }
}

let fetchRowsImpl = fetchRowsOverSsh;

export function setFleetFetchForTests(fn?: (host: string) => Promise<FleetRow[] | null>): void {
  fetchRowsImpl = fn ?? fetchRowsOverSsh;
}

export function resetFleetCacheForTests(): void {
  cache.clear();
  streamHealth.clear();
}

export async function refreshHost(host: string, opts: { force?: boolean } = {}): Promise<void> {
  // A forced refresh must observe state from *after* the event that triggered
  // it: wait out any fetch that predates us, then start a fresh one anyway.
  for (;;) {
    const entry = cache.get(host);
    if (!entry?.inFlight) break;
    await entry.inFlight;
    if (!opts.force) return;
  }
  const entry = cache.get(host);
  if (!opts.force && entry && Date.now() - entry.fetchedAt < refreshWindowMs(host)) return;
  const fetchPromise = (async () => {
    const rows = await fetchRowsImpl(host).catch(() => null);
    const prev = cache.get(host);
    const changed = rows !== null && JSON.stringify(rows) !== JSON.stringify(prev?.rows ?? []);
    cache.set(host, {
      rows: rows ?? prev?.rows ?? [],
      fetchedAt: Date.now(),
      okAt: rows !== null ? Date.now() : (prev?.okAt ?? 0),
      inFlight: null,
    });
    if (changed) notifyCacheChanged();
  })();
  cache.set(host, {
    rows: entry?.rows ?? [],
    fetchedAt: entry?.fetchedAt ?? 0,
    okAt: entry?.okAt ?? 0,
    inFlight: fetchPromise,
  });
  await fetchPromise;
}

// Debounce/coalesce push events into fetches. One hook firing writes several
// files back-to-back (state, snapshot, queue) and each is its own event — a
// single fetch should cover the burst, and an event landing mid-fetch must
// trigger exactly one follow-up (the in-flight fetch may predate it).
const EVENT_DEBOUNCE_MS = 150;
// Floor between consecutive event-driven fetches for one host, so a remote
// with continuous file churn (several busy agents) can't hold the hub in a
// permanent fetch loop — worst case is one ssh exec per second per host.
const EVENT_FETCH_SPACING_MS = 1000;

// Exported for tests; production wires it to the forced refreshHost below.
export function createEventPump(
  refresh: (host: string) => Promise<void>,
  debounceMs: number = EVENT_DEBOUNCE_MS,
  spacingMs: number = EVENT_FETCH_SPACING_MS,
): (host: string) => void {
  const state = new Map<string, { dirty: boolean; running: boolean; lastFetchAt: number }>();
  return (host: string) => {
    let s = state.get(host);
    if (!s) {
      s = { dirty: false, running: false, lastFetchAt: 0 };
      state.set(host, s);
    }
    s.dirty = true;
    if (s.running) return;
    s.running = true;
    void (async () => {
      try {
        while (s.dirty) {
          await Bun.sleep(debounceMs);
          // The floor spans pump runs: the first event fetches after just the
          // debounce, sustained churn is held to one fetch per spacing.
          const wait = s.lastFetchAt + spacingMs - Date.now();
          if (wait > 0) await Bun.sleep(wait);
          s.dirty = false;
          s.lastFetchAt = Date.now();
          await refresh(host).catch(() => {});
        }
      } finally {
        s.running = false;
      }
    })();
  };
}

const pumpRemoteEvent = createEventPump((host) => refreshHost(host, { force: true }));

// Start the push channel for every configured remote and keep the cache hot
// from it. Long-lived consumers (the hub sidebar, `am serve`) call this once;
// one-shot commands never do — they either fetch fresh or read the cache.
let fleetWatchStop: (() => void) | null = null;

export function startFleetEventWatch(): () => void {
  if (fleetWatchStop) return fleetWatchStop;
  const hosts = loadConfig().remotes ?? [];
  if (hosts.length === 0) return () => {};
  const stopWatch = watchRemoteFleetEvents(hosts, {
    onEvent: (host) => pumpRemoteEvent(host),
    onHealth: (host, healthy) => {
      streamHealth.set(host, healthy);
      // On (re)connect, refresh immediately: any events during the outage
      // are gone, so the first fetch is the catch-up.
      if (healthy) pumpRemoteEvent(host);
    },
  });
  fleetWatchStop = () => {
    fleetWatchStop = null;
    streamHealth.clear();
    stopWatch();
  };
  return fleetWatchStop;
}

// How a host should render right now. A fresh okAt proves reachability, but
// so does a live push stream — without that, a single slow poll under the
// relaxed streaming cadence (15s window + 10s fetch timeout can exceed the
// 30s grace) would flap a perfectly healthy host to "unreachable".
// Exported for tests.
export function hostRenderState(
  entry: { okAt: number; inFlight: unknown } | undefined,
  streamHealthy: boolean,
  now: number,
): "rows" | "unreachable" | "pending" {
  if (entry && entry.okAt > 0 && (now - entry.okAt < REMOTE_STALE_GRACE_MS || streamHealthy)) {
    return "rows";
  }
  if (entry && !entry.inFlight) return "unreachable";
  return "pending"; // first fetch still in flight — stay silent, don't flap
}

export function cachedFleetRows(): Fleet {
  const rows: FleetRow[] = agentRows();
  const unreachable: string[] = [];
  for (const host of loadConfig().remotes ?? []) {
    const entry = cache.get(host);
    const render = hostRenderState(entry, streamHealth.get(host) ?? false, Date.now());
    if (render === "rows") rows.push(...entry!.rows);
    else if (render === "unreachable") unreachable.push(host);
    void refreshHost(host);
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

// A subagent's preview comes from `am peek --subagent` on its host — the
// same stale-while-revalidate cache, keyed like its sidebar row.
export function cachedRemoteSubagentPreview(host: string, agentName: string, id: string): string[] | null {
  const key = subagentKey(`${host}:${agentName}`, id);
  const entry = previewCache.get(key);
  if (!entry || (!entry.inFlight && Date.now() - entry.fetchedAt >= PREVIEW_REFRESH_MS)) {
    previewCache.set(key, {
      lines: entry?.lines ?? null,
      fetchedAt: entry?.fetchedAt ?? 0,
      inFlight: true,
    });
    void refreshSubagentPreview(key, host, agentName, id);
  }
  return previewCache.get(key)?.lines ?? null;
}

const PREVIEW_TIMEOUT_MS = 8000;

async function refreshSubagentPreview(key: string, host: string, agentName: string, id: string): Promise<void> {
  const result = await sshAmAsync(host, ["peek", agentName, "--subagent", id, "--lines", "80"], {
    timeoutMs: PREVIEW_TIMEOUT_MS,
  }).catch(() => null);
  const lines = result && result.exitCode === 0 ? result.stdout.replace(/\n+$/, "").split("\n") : null;
  previewCache.set(key, { lines, fetchedAt: Date.now(), inFlight: false });
}

async function refreshPreview(key: string, host: string, agentName: string): Promise<void> {
  // Raw tmux over ssh (no login shell needed): capture the agent's pane.
  // Timed out so a wedged host can't leave the entry inFlight forever, and
  // via sshRunAsync so it rides the shared mux connection.
  const result = await sshRunAsync(host, `tmux capture-pane -p -e -t '=agentmgr-${agentName}:'`, {
    timeoutMs: PREVIEW_TIMEOUT_MS,
  }).catch(() => null);
  const lines = result && result.exitCode === 0 ? result.stdout.replace(/\n+$/, "").split("\n") : null;
  previewCache.set(key, { lines, fetchedAt: Date.now(), inFlight: false });
}

// Sidebar grouping: by host (local first, then each remote) or by project
// (repoRoot when the agent lives in a worktree — grouping by the literal
// worktree dir would put every agent alone — else its dir). Toggled with
// `g`; session-local.
export type GroupMode = "host" | "dir";
export type SortMode = "status" | "recent" | "role";
let groupMode: GroupMode = "host";
let sortMode: SortMode = "status";

export function toggleGroupMode(): GroupMode {
  groupMode = groupMode === "host" ? "dir" : "host";
  return groupMode;
}

export function toggleSortMode(): SortMode {
  sortMode = sortMode === "status" ? "recent" : sortMode === "recent" ? "role" : "status";
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
    if (sort === "role") {
      if (!!a.role !== !!b.role) return a.role ? -1 : 1;
      return (a.role ?? "").localeCompare(b.role ?? "")
        || STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
        || a.name.localeCompare(b.name);
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
const CYAN = "\x1b[38;2;125;207;255m";

// The concierge is part of the management UI rather than the workload, so its
// row is marked everywhere it renders (sidebar, classic picker, palette): a ✦
// ahead of the name and the cyan identity color — it's idle most of the time,
// and the mark is what keeps it findable then. Status still wins where it
// carries signal: needs-attention stays amber, a gone session goes muted.
export function conciergeRow(row: { name: string; role?: string; status: AgentRow["status"] }): { label: string; labelStyle: string; role: string } | null {
  if ((row.role ?? (row.name === CONCIERGE_NAME ? CONCIERGE_NAME : undefined)) !== CONCIERGE_NAME) return null;
  const labelStyle = row.status === "needs-attention"
    ? AMBER
    : row.status === "exited" || row.status === "dead"
      ? MUTED
      : CYAN;
  return { label: `✦ ${CONCIERGE_NAME}`, labelStyle, role: "fleet concierge" };
}

export function sidebarStatus(status: AgentRow["status"]): string {
  if (status === "needs-attention") return "needs you";
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

export function fleetPickerItem(r: FleetRow): PickerItem {
  const concierge = conciergeRow(r);
  const since = relativeTime(r.statusChangedAt ?? r.updatedAt);
  // Who created it is a fact for the card, not a tree: agents no longer
  // spawn agents, and what nests under a row is its built-in subagents.
  // The concierge creates workers for the operator, so it isn't shown at all.
  const spawnedBy = r.spawnedBy === CONCIERGE_NAME ? undefined : r.spawnedBy;
  return {
    name: fleetKey(r),
    section: sectionFor(r, groupMode),
    secondary: r.status === "exited",
    icon: STATUS_ICONS[r.status],
    iconStyle: STATUS_COLORS[r.status],
    status: r.status,
    statusLabel: sidebarStatus(r.status),
    label: concierge?.label ?? r.name,
    labelStyle: concierge?.labelStyle ?? (r.status === "needs-attention" ? AMBER : r.status === "idle" ? MUTED : FG),
    role: r.role,
    badge: r.provider === "codex" ? "cdx" : "cld",
    badgeStyle: r.provider === "codex" ? MUTED : PURPLE,
    badgeSelectedStyle: r.provider === "codex" ? BLUE : PURPLE,
    queueDepth: r.queued,
    right: r.role && !concierge ? (r.role.length > 10 ? `${r.role.slice(0, 9)}…` : r.role) : undefined,
    rightStyle: CYAN,
    statusAge: since,
    // "front desk"/"assistant" make palette queries find the concierge.
    search: `${r.task ?? ""} ${shortenHome(r.dir)} ${r.provider} ${r.role ?? "unassigned"} ${r.host ?? "local"} ${spawnedBy ?? ""}${concierge ? " front desk assistant" : ""}`,
    meta: [
      `role     ${r.role ? `${CYAN}${r.role}${FG}` : "—"}`,
      ...(r.subagents ? [`agents   ${GREEN}${r.subagents.active} · ${r.subagents.types}${FG}`] : []),
      ...(spawnedBy ? [`parent   ${spawnedBy}`] : []),
      `host     ${r.host ?? "local"}`,
      `provider ${r.provider}`,
      r.worktreeBranch ? `branch   ${r.worktreeBranch}` : `dir      ${shortenHome(r.dir)}`,
      `reason   ${r.status === "waiting" ? (r.statusDetail ?? "—") : (r.statusReason ?? "—")}`,
      `since    ${since}`,
      `diff     ${diffDetail(r)}`,
      `updated  ${relativeTime(r.updatedAt)}${r.diff?.dirty ? ` ${MUTED}· uncommitted${FG}` : ""}`,
    ],
  };
}

// Sidebar keys for a subagent: the agent's own key, then the subagent id.
// The separator can't appear in an agent name (alphanumeric, dash,
// underscore) or a host alias.
export const SUBAGENT_KEY_SEP = "⤷";

export function subagentKey(agentKey: string, id: string): string {
  return `${agentKey}${SUBAGENT_KEY_SEP}${id}`;
}

export function splitSubagentKey(key: string): { agentKey: string; id: string } | null {
  const at = key.indexOf(SUBAGENT_KEY_SEP);
  if (at === -1) return null;
  return { agentKey: key.slice(0, at), id: key.slice(at + SUBAGENT_KEY_SEP.length) };
}

// The built-in subagents running under an agent, as rows nested beneath it.
// They have no pane to attach to; selecting one shows its transcript.
export function subagentPickerItems(r: FleetRow): PickerItem[] {
  const parentKey = fleetKey(r);
  return (r.subagents?.running ?? []).map((sub) => ({
    name: subagentKey(parentKey, sub.id),
    parent: parentKey,
    section: sectionFor(r, groupMode),
    icon: "⤷",
    iconStyle: GREEN,
    status: "working",
    statusLabel: "subagent",
    label: sub.type,
    labelStyle: FG,
    roleFilterable: false,
    attachable: false,
    statusAge: relativeTime(sub.startedAt),
    search: `${sub.type} ${r.name} subagent`,
    meta: [
      `subagent ${CYAN}${sub.type}${FG}`,
      `of       ${r.name}`,
      `host     ${r.host ?? "local"}`,
      `started  ${relativeTime(sub.startedAt)}`,
      `output   am peek ${r.name} --subagent ${sub.id.slice(0, 8)} --follow`,
    ],
  }));
}

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
  const items: PickerItem[] = sorted.flatMap((row) => [fleetPickerItem(row), ...subagentPickerItems(row)]);
  for (const host of unreachable) {
    items.push({
      name: `${host}:`,
      section: host,
      secondary: false,
      icon: "✕",
      iconStyle: STATUS_COLORS.dead,
      status: "dead",
      statusLabel: "unreachable",
      roleFilterable: false,
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
