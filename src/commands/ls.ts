import { homedir } from "node:os";
import { agentProvider, listAgents, type AgentState, type Provider } from "../state";
import { queueDepth } from "../queue";
import { capturePane, hasSession } from "../tmux";

export type DisplayStatus = AgentState["status"] | "dead" | "waiting";

export const STATUS_ICONS: Record<DisplayStatus, string> = {
  starting: "◌",
  idle: "○",
  waiting: "◐",
  working: "●",
  "needs-attention": "⚠",
  exited: "✔",
  dead: "✕",
};

// SGR color for the picker's leading status glyph, so state reads at a glance
// without crowding the row. Active = green, needs-eyes = yellow, quiet = dim,
// gone = dim red.
export const STATUS_COLORS: Record<DisplayStatus, string> = {
  starting: "\x1b[2m", // dim
  idle: "\x1b[2m",
  waiting: "\x1b[33m", // yellow
  working: "\x1b[32m", // green
  "needs-attention": "\x1b[33m",
  exited: "\x1b[31;2m", // dim red
  dead: "\x1b[31;2m",
};

// Claude Code fires no hook when a session goes idle while waiting on a
// timer (scheduled wake-ups) or a background task — from the hooks' view
// that's plain idle. Best-effort detection: scrape the pane's STATUS REGION
// (below the last horizontal separator, where Claude Code renders these
// indicators) so ordinary conversation text mentioning "background task"
// can't false-positive. Patterns may need tuning as the UI strings evolve.
const WAITING_PATTERNS = [
  /\bwake-?up\b/i, // scheduled wake-up countdowns (/loop, ScheduleWakeup)
  /\bbackground task/i,
  /\bbash(es)? running/i,
];
const SEPARATOR_RE = /─{8,}/;
const STATUS_REGION_FALLBACK_LINES = 4;
const DETAIL_MAX = 48;

export interface WaitingInfo {
  waiting: boolean;
  // The matching indicator line, cleaned ("wake-up in 3m 12s"), for display.
  detail?: string;
}

export function paneWaitingInfo(rawLines: string[]): WaitingInfo {
  // Callers pass plain or colored captures; SGR codes would pollute the
  // extracted detail and could split a separator match.
  const lines = rawLines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  let sep = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SEPARATOR_RE.test(lines[i]!)) {
      sep = i;
      break;
    }
  }
  const region = sep >= 0 ? lines.slice(sep + 1) : lines.slice(-STATUS_REGION_FALLBACK_LINES);
  for (const line of region) {
    if (WAITING_PATTERNS.some((re) => re.test(line))) {
      const detail = line.replace(/^[^a-zA-Z0-9]+/, "").trim();
      return { waiting: true, detail: clipDetail(detail) };
    }
  }
  return { waiting: false };
}

function clipDetail(text: string): string {
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX - 1) + "…" : text;
}

// The scrape forks a tmux subprocess; the sidebar reloads every second and
// the daemon serves /agents per request, so cache per agent for a few
// seconds — waiting state doesn't flicker that fast.
const WAITING_CACHE_MS = 3000;
const waitingCache = new Map<string, { info: WaitingInfo; at: number }>();

export function waitingInfo(agent: AgentState): WaitingInfo {
  const cached = waitingCache.get(agent.tmuxSession);
  if (cached && Date.now() - cached.at < WAITING_CACHE_MS) return cached.info;
  const pane = capturePane(agent.tmuxSession);
  const info = pane ? paneWaitingInfo(pane) : { waiting: false };
  waitingCache.set(agent.tmuxSession, { info, at: Date.now() });
  return info;
}

// State files can outlive their tmux session (machine reboot, manual kill).
export function displayStatus(agent: AgentState): DisplayStatus {
  if (agent.status !== "exited" && !hasSession(agent.tmuxSession)) return "dead";
  if (agent.status === "idle" && waitingInfo(agent).waiting) return "waiting";
  return agent.status;
}

export function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function shortenHome(path: string): string {
  return path.startsWith(homedir()) ? "~" + path.slice(homedir().length) : path;
}

export interface AgentRow {
  name: string;
  status: DisplayStatus;
  provider: Provider;
  queued: number;
  updatedAt: string;
  dir: string;
  // Carried through from AgentState by the spread in agentRows() — declared
  // so fleet/picker code can use them on rows that crossed a JSON boundary.
  task?: string;
  worktreeBranch?: string;
  createdAt?: string;
  // For waiting agents: the indicator line ("wake-up in 3m"), display-ready.
  statusDetail?: string;
}

export function agentRows(): AgentRow[] {
  return listAgents().map((a) => {
    const status = displayStatus(a);
    return {
      ...a,
      status,
      provider: agentProvider(a),
      queued: queueDepth(a.name),
      // waitingInfo is cached, so this second call is free.
      statusDetail: status === "waiting" ? waitingInfo(a).detail : undefined,
    };
  });
}

export function formatRows(rows: (AgentRow & { host?: string })[]): string[] {
  if (rows.length === 0) return ["no agents — create one with `am new <name>`"];
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const statusOf = (r: AgentRow) => (r.statusDetail ? `${r.status} · ${r.statusDetail}` : r.status);
  const statusWidth = Math.max(6, ...rows.map((r) => statusOf(r).length));
  const withHost = rows.some((r) => r.host);
  const hostWidth = withHost ? Math.max(4, ...rows.map((r) => (r.host ?? "local").length)) : 0;
  const hostHeader = withHost ? `${"HOST".padEnd(hostWidth)}  ` : "";
  const lines = [
    `  ${"NAME".padEnd(nameWidth)}  ${hostHeader}${"STATUS".padEnd(statusWidth)}  AGENT   QUEUED  ACTIVITY  DIR`,
  ];
  for (const r of rows) {
    const queued = r.queued > 0 ? String(r.queued) : "–";
    const host = withHost ? `${(r.host ?? "local").padEnd(hostWidth)}  ` : "";
    lines.push(
      `${STATUS_ICONS[r.status]} ${r.name.padEnd(nameWidth)}  ${host}${statusOf(r).padEnd(statusWidth)}  ${r.provider.padEnd(6)}  ${queued.padEnd(6)}  ${relativeTime(r.updatedAt).padEnd(8)}  ${shortenHome(r.dir)}`,
    );
  }
  return lines;
}

export function lsCommand(opts: { json: boolean; localOnly?: boolean }): void {
  // Imported lazily to keep ls.ts free of a fleet→ls→fleet import cycle at
  // module-eval time (fleet imports agentRows from here).
  const { fleetRows } = require("../fleet") as typeof import("../fleet");
  const fleet = fleetRows({ localOnly: opts.localOnly });
  if (opts.json) {
    console.log(JSON.stringify(fleet.rows, null, 2));
    return;
  }
  const lines = formatRows(fleet.rows);
  for (const host of fleet.unreachable) lines.push(`\x1b[2m  (${host} unreachable)\x1b[0m`);
  console.log(lines.join("\n"));
}
