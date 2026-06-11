import { homedir } from "node:os";
import { listAgents, type AgentState } from "../state";
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

// Claude Code fires no hook when a session goes idle while waiting on a
// timer (scheduled wake-ups) or a background task — from the hooks' view
// that's plain idle. Best-effort detection: scrape the visible bottom of the
// pane for the indicators Claude Code renders in those states. Patterns may
// need tuning as Claude Code's UI strings evolve.
const WAITING_PATTERNS = [
  /\bwake-?up\b/i, // scheduled wake-up countdowns (/loop, ScheduleWakeup)
  /\bbackground task/i,
  /\bbash(es)? running/i,
];
const WAITING_TAIL_LINES = 12;

export function paneLooksWaiting(lines: string[]): boolean {
  const tail = lines.slice(-WAITING_TAIL_LINES).join("\n");
  return WAITING_PATTERNS.some((re) => re.test(tail));
}

// State files can outlive their tmux session (machine reboot, manual kill).
export function displayStatus(agent: AgentState): DisplayStatus {
  if (agent.status !== "exited" && !hasSession(agent.tmuxSession)) return "dead";
  if (agent.status === "idle") {
    const pane = capturePane(agent.tmuxSession);
    if (pane && paneLooksWaiting(pane)) return "waiting";
  }
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
  queued: number;
  updatedAt: string;
  dir: string;
}

export function agentRows(): AgentRow[] {
  return listAgents().map((a) => ({
    ...a,
    status: displayStatus(a),
    queued: queueDepth(a.name),
  }));
}

export function formatRows(rows: AgentRow[]): string[] {
  if (rows.length === 0) return ["no agents — create one with `am new <name>`"];
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));
  const lines = [`  ${"NAME".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  QUEUED  ACTIVITY  DIR`];
  for (const r of rows) {
    const queued = r.queued > 0 ? String(r.queued) : "–";
    lines.push(
      `${STATUS_ICONS[r.status]} ${r.name.padEnd(nameWidth)}  ${r.status.padEnd(statusWidth)}  ${queued.padEnd(6)}  ${relativeTime(r.updatedAt).padEnd(8)}  ${shortenHome(r.dir)}`,
    );
  }
  return lines;
}

export function lsCommand(opts: { json: boolean }): void {
  const rows = agentRows();
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(formatRows(rows).join("\n"));
}
