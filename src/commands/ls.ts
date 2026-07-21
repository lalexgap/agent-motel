import { homedir } from "node:os";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, agentSessionId, listAgents, type AgentState, type Provider } from "../state";
import { claudeProjectSlug } from "../transcript";
import { queueDepth } from "../queue";
import { capturePane, hasSession, stripSgr } from "../tmux";

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
  starting: "\x1b[38;2;86;95;137m", // muted
  idle: "\x1b[38;2;86;95;137m",
  waiting: "\x1b[38;2;224;175;104m", // amber
  working: "\x1b[38;2;158;206;106m", // green
  "needs-attention": "\x1b[38;2;224;175;104m",
  exited: "\x1b[38;2;119;70;82m", // dim red
  dead: "\x1b[38;2;119;70;82m",
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
  /\bbash(es)? running/i, // older Claude Code wording
  /\b\d+ shells?\b/i, // current wording: "1 shell · ← for agents"
];
const SEPARATOR_RE = /─{8,}/;
const STATUS_REGION_FALLBACK_LINES = 4;
const DETAIL_MAX = 64;

export interface WaitingInfo {
  waiting: boolean;
  // The matching indicator line, cleaned ("wake-up in 3m 12s"), for display.
  detail?: string;
}

export function paneWaitingInfo(rawLines: string[]): WaitingInfo {
  // Callers pass plain or colored captures; SGR codes would pollute the
  // extracted detail and could split a separator match.
  const lines = rawLines.map(stripSgr);
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

// Background watchers (gh pr checks --watch, log pollers, sleep-then-act
// chains) stream their output to the session tasks directory — the pane only
// says "N bashes running", but the freshest task file's tail says what
// they're actually doing (agents write greppable verdict lines there).
export function sessionTasksDir(agent: AgentState): string | null {
  const sessionId = agentSessionId(agent);
  if (!sessionId) return null;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join("/tmp", `claude-${uid}`, claudeProjectSlug(agent.dir), sessionId, "tasks");
}

export function lastNonEmptyLine(text: string): string | null {
  const lines = stripSgr(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1]! : null;
}

const TAIL_BYTES = 4096;
function fileTail(path: string): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const length = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, Math.max(0, size - length));
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const BG_RECENT_MS = 30 * 60 * 1000;

export interface BackgroundTasks {
  count: number; // files touched in the last 30 minutes
  lastLine: string | null; // tail of the freshest output file
  ageSeconds: number;
}

export function backgroundTasks(agent: AgentState): BackgroundTasks | null {
  const dir = sessionTasksDir(agent);
  if (!dir || !existsSync(dir)) return null;
  const files: { path: string; mtime: number }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".output")) continue;
    try {
      files.push({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs });
    } catch {
      // raced a cleanup
    }
  }
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  const freshest = files[0]!;
  let lastLine: string | null = null;
  try {
    lastLine = lastNonEmptyLine(fileTail(freshest.path));
  } catch {
    // unreadable tail is fine — fall back to the pane detail
  }
  return {
    count: files.filter((f) => Date.now() - f.mtime < BG_RECENT_MS).length,
    lastLine,
    ageSeconds: Math.max(0, (Date.now() - freshest.mtime) / 1000),
  };
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
  let info: WaitingInfo = pane ? paneWaitingInfo(pane) : { waiting: false };
  // Waiting on background tasks: the pane says how many, the tasks dir says
  // what they're doing — show the freshest watcher's last output line.
  if (info.waiting && /background|bash|shell/i.test(info.detail ?? "")) {
    const bg = backgroundTasks(agent);
    if (bg?.lastLine) {
      const stale = bg.ageSeconds > 600 ? ` (${Math.floor(bg.ageSeconds / 60)}m ago)` : "";
      info = { waiting: true, detail: clipDetail(`${bg.count} bg — ${bg.lastLine}${stale}`) };
    }
  }
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
  reportTo?: string;
  // The agent that spawned this one (AGENTMGR_AGENT at `am new`). Surfaced as
  // the "parent" line in the sidebar; absent for human-spawned agents.
  spawnedBy?: string;
  // Previous exact names accepted for routing after a rename. Included in
  // fleet JSON so another host can forward old peer replies correctly.
  aliases?: string[];
  // For waiting agents: the indicator line ("wake-up in 3m"), display-ready.
  statusDetail?: string;
  repoRoot?: string;
  // null = checked, dir is not a git checkout; undefined = not checked yet.
  diff?: DiffSummary | null;
}

export interface DiffSummary {
  added: number;
  removed: number;
  files: number;
  dirty: boolean;
}

const DIFF_CACHE_MS = 3000;
const diffCache = new Map<string, { value: DiffSummary | null; at: number }>();
const diffInFlight = new Set<string>();
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function summarizeDiff(statusText: string, numstatText: string): DiffSummary {
  const statusLines = statusText.split("\n").filter(Boolean);
  let added = 0;
  let removed = 0;
  for (const line of numstatText.split("\n")) {
    const [a, r] = line.split("\t");
    if (a && a !== "-") added += Number(a) || 0;
    if (r && r !== "-") removed += Number(r) || 0;
  }
  return { added, removed, files: statusLines.length, dirty: statusLines.length > 0 };
}

// Best-effort worktree summary for the sidebar detail card. The picker refreshes
// every second, so cache the git subprocesses; a three-second delay is still
// effectively live while avoiding a process storm across a large fleet.
export function gitDiffSummary(dir: string): DiffSummary | null {
  const cached = diffCache.get(dir);
  if (cached && Date.now() - cached.at < DIFF_CACHE_MS) return cached.value;

  const status = Bun.spawnSync(["git", "-C", dir, "status", "--short", "--untracked-files=all"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (status.exitCode !== 0) {
    diffCache.set(dir, { value: null, at: Date.now() });
    return null;
  }

  const numstat = Bun.spawnSync(["git", "-C", dir, "diff", "--numstat", "HEAD", "--"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const value = summarizeDiff(decode(status.stdout), numstat.exitCode === 0 ? decode(numstat.stdout) : "");
  diffCache.set(dir, { value, at: Date.now() });
  return value;
}

async function gitText(dir: string, args: string[]): Promise<{ text: string; ok: boolean }> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { text, ok: exitCode === 0 };
}

// The fleet can contain hundreds of historical agents. First paint must never
// wait for their repositories, so the UI uses this stale-while-revalidate path
// and picks up results on its next one-second refresh. Returns undefined
// while the first check is still in flight, null for a dir that turned out
// not to be a git checkout.
export function cachedGitDiffSummary(dir: string): DiffSummary | null | undefined {
  const cached = diffCache.get(dir);
  if ((!cached || Date.now() - cached.at >= DIFF_CACHE_MS) && !diffInFlight.has(dir)) {
    diffInFlight.add(dir);
    void Promise.all([
      gitText(dir, ["status", "--short", "--untracked-files=all"]),
      gitText(dir, ["diff", "--numstat", "HEAD", "--"]),
    ]).then(([status, numstat]) => {
      diffCache.set(dir, {
        value: status.ok ? summarizeDiff(status.text, numstat.ok ? numstat.text : "") : null,
        at: Date.now(),
      });
    }).finally(() => diffInFlight.delete(dir));
  }
  return cached ? cached.value : undefined;
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
    // Diff stats ride along in the JSON: the hub polls remote fleets through
    // `am ls --json --local-only` over ssh, and only this process can see this
    // machine's worktrees. Active agents only — exited ones can number in the
    // hundreds and nobody attaches to them.
    for (const row of fleet.rows) {
      const local = !("host" in row && row.host);
      if (local && row.status !== "exited" && row.diff === undefined) {
        row.diff = gitDiffSummary(row.dir);
      }
    }
    console.log(JSON.stringify(fleet.rows, null, 2));
    return;
  }
  const lines = formatRows(fleet.rows);
  for (const host of fleet.unreachable) lines.push(`\x1b[2m  (${host} unreachable)\x1b[0m`);
  console.log(lines.join("\n"));
}
