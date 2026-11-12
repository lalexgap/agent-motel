import { homedir } from "node:os";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, agentSessionId, listAgents, type AgentState, type Provider } from "../state";
import { claudeProjectSlug } from "../transcript";
import { planFile } from "../paths";
import { queueDepth } from "../queue";
import { capturePane, hasSession, stripSgr } from "../tmux";
import { roleForAgent } from "../roles";
import {
  describeRunning,
  lastReportedStop,
  readSubagents,
  reconcileOpenSubagents,
  subagentLabel,
  subagentLiveness,
  summarize,
  type SubagentRecord,
  type SubagentSummary,
} from "../subagents";
import { reconcileAntigravityAgent } from "../antigravity";
import { CLAUDE_TRUST_PROMPT_REASON, paneShowsClaudeTrustPrompt } from "../claudeTrust";

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
  // Background shells/tasks the indicator counts; 0 for a wake-up timer.
  background?: number;
}

const BACKGROUND_COUNTS = [/\b(\d+) shells?\b/i, /\b(\d+) background tasks?\b/i, /\b(\d+) bash(?:es)? running/i];

// How many background shells an indicator line reports. A wording that names
// them without a number still means at least one. Pure.
export function backgroundCount(line: string): number {
  for (const re of BACKGROUND_COUNTS) {
    const match = re.exec(line);
    if (match) return Number(match[1]);
  }
  return /\bbackground task|\bbash(es)? running/i.test(line) ? 1 : 0;
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
      return { waiting: true, detail: clipDetail(detail), background: backgroundCount(line) };
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
  if (agentProvider(agent) === "antigravity") return null;
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

// Subagent .output files are JSONL transcripts (symlinks to subagents/*.jsonl);
// their tail is never a readable status line.
function isTranscript(path: string): boolean {
  if (lstatSync(path).isSymbolicLink() && readlinkSync(path).endsWith(".jsonl")) return true;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return /^\{"(parentUuid":|type":"fork-context-ref")/.test(buf.toString("utf8", 0, n));
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
    if (!isTranscript(freshest.path)) lastLine = lastNonEmptyLine(fileTail(freshest.path));
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
  if (agentProvider(agent) === "antigravity") return { waiting: false };
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
      info = { ...info, detail: clipDetail(`${bg.count} bg — ${bg.lastLine}${stale}`) };
    }
  }
  waitingCache.set(agent.tmuxSession, { info, at: Date.now() });
  return info;
}

const trustPromptCache = new Map<string, { shown: boolean; at: number }>();

// A Claude or Antigravity agent still at the folder-trust prompt fires no hooks,
// so it would read as "starting" forever.
export function atClaudeTrustPrompt(agent: AgentState): boolean {
  const provider = agentProvider(agent);
  if (agent.status !== "starting" || (provider !== "claude" && provider !== "antigravity")) return false;
  const cached = trustPromptCache.get(agent.tmuxSession);
  if (cached && Date.now() - cached.at < WAITING_CACHE_MS) return cached.shown;
  const pane = capturePane(agent.tmuxSession);
  const shown = !!pane && paneShowsClaudeTrustPrompt(pane.map(stripSgr));
  trustPromptCache.set(agent.tmuxSession, { shown, at: Date.now() });
  return shown;
}

// What an agent idle at its prompt is still waiting on. Present only then: a
// turn in progress is busy with itself.
export interface BusyWith {
  // Live in-session subagents (Claude's background agents).
  subagents: number;
  // Background shells/tasks the pane reports.
  background: number;
}

// How an agent is shown, against what its state file stores.
//
// The stored status stays raw: `idle` means "at its prompt", which is what
// delivery, the queue drain, `am send`, model switches and delivery receipts
// act on — a parent waiting on subagents takes a message exactly as an idle
// one does. Everything that SHOWS a status (`am ls`, `am summary`, the hub,
// the web and macOS apps, `am peek`) reads this instead, where an idle agent
// with live subagents is `working`.
export interface Presence {
  status: DisplayStatus;
  rawStatus: AgentState["status"];
  // Why, display-ready: "waiting on 2 subagents (Shepherd PR 74, reviewer)".
  reason?: string;
  busyWith?: BusyWith;
  // Idle with a subagent that ended or went silent, and no turn since: shown
  // as needs-attention, though nothing is running and nothing blocks a stop.
  stalled?: boolean;
  // The subagent rollup, read once here so rows don't reread the ledger.
  subagents?: SubagentSummary;
}

// How long a parent gets to pick up a finished subagent before it is flagged.
// The provider wakes it within a second, so minutes of nothing is a parent
// that was never told (or a child that died without a word).
export const STALLED_AFTER_MS = 10 * 60 * 1000;
// Past this the flag is old news: the agent reads idle again.
export const STALLED_FORGET_MS = 24 * 60 * 60 * 1000;
const REASON_LABELS = 3;
const REASON_LABEL_CHARS = 48;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function age(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function shortLabel(sub: { type: string; description?: string }): string {
  const label = subagentLabel(sub);
  return label.length > REASON_LABEL_CHARS ? label.slice(0, REASON_LABEL_CHARS - 1) + "…" : label;
}

// "waiting on 2 subagents (Shepherd PR 74, reviewer) and 1 shell". Pure.
export function waitingOnReason(live: { type: string; description?: string }[], background = 0): string {
  const labels: string[] = [];
  for (const sub of live) {
    const label = shortLabel(sub);
    if (!labels.includes(label)) labels.push(label);
  }
  const named = labels.slice(0, REASON_LABELS).join(", ") + (labels.length > REASON_LABELS ? ` +${labels.length - REASON_LABELS}` : "");
  const shells = background > 0 ? ` and ${plural(background, "shell")}` : "";
  return `waiting on ${plural(live.length, "subagent")} (${named})${shells}`;
}

export interface BusyInput {
  // Idle or waiting: what the agent would show without its subagents.
  status: "idle" | "waiting";
  background?: number;
  // When it went idle. A subagent that ended after this ended on a parent
  // that has not taken a turn since.
  idleSince?: string;
  live: SubagentRecord[];
  quiet: SubagentRecord[];
  quietSince?: number;
  lastStop?: SubagentRecord | null;
  now: number;
}

// The derivation itself, for an agent whose stored status is idle. Pure.
export function busyPresence(input: BusyInput): Pick<Presence, "status" | "reason" | "busyWith" | "stalled"> {
  const background = input.background ?? 0;
  if (input.live.length > 0) {
    return {
      status: "working",
      reason: waitingOnReason(input.live, background),
      busyWith: { subagents: input.live.length, background },
    };
  }
  const busyWith = background > 0 ? { subagents: 0, background } : undefined;
  // Something else is still due to wake it (a shell, a timer): not stalled.
  if (input.status !== "idle") return { status: input.status, busyWith };
  const flagged = (since: number) => {
    const waited = input.now - since;
    return waited >= STALLED_AFTER_MS && waited < STALLED_FORGET_MS ? waited : null;
  };
  if (input.quiet.length > 0) {
    // Silent for QUIET_AFTER_MS already, so there is no second grace period.
    const silent = input.now - (input.quietSince ?? input.now);
    if (silent >= STALLED_FORGET_MS) return { status: "idle" };
    const who = input.quiet.length === 1 ? `subagent ${shortLabel(input.quiet[0]!)}` : plural(input.quiet.length, "subagent");
    return {
      status: "needs-attention",
      stalled: true,
      reason: `${who} silent for ${age(silent)} — the agent is still waiting on ${input.quiet.length === 1 ? "it" : "them"}`,
    };
  }
  const stop = input.lastStop;
  const ended = stop?.endedAt ? Date.parse(stop.endedAt) : NaN;
  const idleSince = input.idleSince ? Date.parse(input.idleSince) : NaN;
  if (stop && Number.isFinite(ended) && Number.isFinite(idleSince) && ended > idleSince) {
    const waited = flagged(ended);
    if (waited !== null) {
      return {
        status: "needs-attention",
        stalled: true,
        reason: `subagent ${shortLabel(stop)} finished ${age(waited)} ago and the agent has not resumed`,
      };
    }
  }
  return { status: "idle" };
}

// State files can outlive their tmux session (machine reboot, manual kill).
export function agentPresence(agent: AgentState, now = Date.now()): Presence {
  if (agentProvider(agent) === "antigravity" && !agent.antigravityRunId) {
    Object.assign(agent, reconcileAntigravityAgent(agent));
  }
  const rawStatus = agent.status;
  if (rawStatus === "exited") return { status: "exited", rawStatus, reason: agent.statusReason };
  if (!hasSession(agent.tmuxSession)) return { status: "dead", rawStatus, reason: agent.statusReason };
  // Subagents live and die inside a session, so only a live one is asked.
  let records: SubagentRecord[] = [];
  if (agentProvider(agent) !== "antigravity") {
    try {
      reconcileOpenSubagents(agent);
    } catch {
      // the ledger as it stands
    }
    records = readSubagents(agent.name);
  }
  const subagents = describeRunning(agent, summarize(records)) ?? undefined;
  if (atClaudeTrustPrompt(agent)) return { status: "needs-attention", rawStatus, reason: CLAUDE_TRUST_PROMPT_REASON, subagents };
  if (rawStatus !== "idle") return { status: rawStatus, rawStatus, reason: agent.statusReason, subagents };
  const waiting = waitingInfo(agent);
  const derived = busyPresence({
    status: waiting.waiting ? "waiting" : "idle",
    background: waiting.background,
    idleSince: agent.statusChangedAt,
    ...subagentLiveness(agent, records, now),
    lastStop: lastReportedStop(records),
    now,
  });
  return { ...derived, rawStatus, reason: derived.reason ?? agent.statusReason, subagents };
}

export function displayStatus(agent: AgentState): DisplayStatus {
  return agentPresence(agent).status;
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
  statusReason?: string;
  statusChangedAt?: string;
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
  role?: string;
  // The agent that spawned this one (AGENTMGR_AGENT at `am new`). Surfaced as
  // the "parent" line in the sidebar; absent for human-spawned agents.
  spawnedBy?: string;
  // Previous exact names accepted for routing after a rename. Included in
  // fleet JSON so another host can forward old peer replies correctly.
  aliases?: string[];
  // The stored status, where `status` is how the agent is shown: an agent
  // idle at its prompt with live subagents is `working` here and `idle`
  // there. Absent from a remote whose am predates it.
  rawStatus?: AgentState["status"];
  // What an idle-at-prompt agent is still waiting on. Absent when nothing.
  busyWith?: BusyWith;
  // Extra context for the status column, display-ready: the waiting indicator
  // ("wake-up in 3m") for waiting agents, what an idle agent is waiting on,
  // the subagent rollup for a turn in progress.
  statusDetail?: string;
  // In-session subagents currently running under this agent (the Task tool /
  // codex subagents). Absent when none are.
  subagents?: SubagentSummary;
  repoRoot?: string;
  // null = checked, dir is not a git checkout; undefined = not checked yet.
  diff?: DiffSummary | null;
  // The agent's running plan file (am plan), when it has one. JSON only.
  planFile?: string;
  prMonitor?: AgentState["prMonitor"];
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
    const presence = agentPresence(a);
    const { status, subagents } = presence;
    const { roleInstructions: _roleInstructions, ...visible } = a;
    const derived = !!presence.busyWith?.subagents || !!presence.stalled;
    return {
      ...visible,
      status,
      rawStatus: presence.rawStatus,
      statusReason: presence.reason,
      provider: agentProvider(a),
      role: roleForAgent(a),
      queued: queueDepth(a.name),
      subagents,
      ...(presence.busyWith ? { busyWith: presence.busyWith } : {}),
      // waitingInfo is cached, so this second call is free. A waiting agent's
      // own indicator wins the status column, then what an idle agent is
      // waiting on; otherwise the subagent rollup fills it, so a fanned-out
      // turn reads as more than plain "working".
      statusDetail: status === "waiting"
        ? waitingInfo(a).detail
        : derived
          ? clipDetail(presence.reason ?? "")
          : subagents && clipDetail(subagents.detail),
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
  const roleWidth = Math.max(4, ...rows.map((r) => (r.role ?? "–").length));
  const lines = [
    `  ${"NAME".padEnd(nameWidth)}  ${hostHeader}${"STATUS".padEnd(statusWidth)}  AGENT   ${"ROLE".padEnd(roleWidth)}  QUEUED  ACTIVITY  DIR`,
  ];
  for (const r of rows) {
    const queued = r.queued > 0 ? String(r.queued) : "–";
    const host = withHost ? `${(r.host ?? "local").padEnd(hostWidth)}  ` : "";
    lines.push(
      `${STATUS_ICONS[r.status]} ${r.name.padEnd(nameWidth)}  ${host}${statusOf(r).padEnd(statusWidth)}  ${r.provider.padEnd(6)}  ${(r.role ?? "–").padEnd(roleWidth)}  ${queued.padEnd(6)}  ${relativeTime(r.updatedAt).padEnd(8)}  ${shortenHome(r.dir)}`,
    );
  }
  return lines;
}

export type LsSort = "status" | "recent" | "role";

export function filterRowsByRole<T extends { role?: string }>(rows: T[], role?: string): T[] {
  if (!role) return rows;
  return rows.filter((row) => role === "unassigned" ? !row.role : row.role === role);
}

export function sortLsRows<T extends AgentRow & { host?: string }>(rows: T[], sort?: string): T[] {
  if (!sort) return rows;
  if (sort !== "status" && sort !== "recent" && sort !== "role") {
    throw new Error(`--sort must be status, recent, or role, got "${sort}"`);
  }
  const priority: Record<AgentRow["status"], number> = {
    "needs-attention": 0, working: 1, waiting: 2, starting: 3, idle: 4, exited: 5, dead: 6,
  };
  return [...rows].sort((a, b) => {
    if (sort === "recent") return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.name.localeCompare(b.name);
    if (sort === "role") {
      if (!!a.role !== !!b.role) return a.role ? -1 : 1;
      return (a.role ?? "").localeCompare(b.role ?? "")
        || priority[a.status] - priority[b.status]
        || a.name.localeCompare(b.name);
    }
    return priority[a.status] - priority[b.status] || a.name.localeCompare(b.name);
  });
}

export function lsCommand(opts: { json: boolean; localOnly?: boolean; role?: string; sort?: string }): void {
  // Imported lazily to keep ls.ts free of a fleet→ls→fleet import cycle at
  // module-eval time (fleet imports agentRows from here).
  const { fleetRows } = require("../fleet") as typeof import("../fleet");
  const fleet = fleetRows({ localOnly: opts.localOnly });
  fleet.rows = sortLsRows(filterRowsByRole(fleet.rows, opts.role), opts.sort);
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
      if (local && existsSync(planFile(row.name))) row.planFile = planFile(row.name);
    }
    console.log(JSON.stringify(fleet.rows, null, 2));
    return;
  }
  const lines = formatRows(fleet.rows);
  for (const host of fleet.unreachable) lines.push(`\x1b[2m  (${host} unreachable)\x1b[0m`);
  console.log(lines.join("\n"));
}
