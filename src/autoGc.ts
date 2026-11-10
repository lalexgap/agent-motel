import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, type Config } from "./config";
import { withAuditContext } from "./audit";
import { withFileLock } from "./filelock";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import {
  WorktreeJudge, acquireGcLock, applyGc, diskBytes, gcPolicy, listWorktreeCandidates, logGc, planGc, readGcLog, removeWorktree,
  type GcLogEntry, type KeptKind, type KeptWorktree,
} from "./gc";
import { gcLogFile, gcStateFile } from "./paths";
import { awaitQuiet, configNumber, pressureReason, readPressure, type Pressure } from "./pressure";
import { cliEntrypoint } from "./settings";
import { listAgents } from "./state";

// Scheduled gc. The daemon decides when (autoGcDue) and starts the sweep as a
// separate low-priority process (runAutoGc), so slow git and disk work never
// sits in the daemon's event loop. The sweep applies `am gc`'s policy, but
// rations the expensive part: it inspects one worktree at a time, pauses
// between them, waits before each while the host is under pressure, and
// stops at a time budget, picking up the worktrees it did not reach on its
// next run.

// Bump when the policy starts collecting something it did not before: the
// next scheduled run is then a dry run again.
export const GC_POLICY_VERSION = 1;

const MINUTE_MS = 60_000;
const TICK_MS = MINUTE_MS;
// After the quiet hour passes, the sweep still starts unprompted this long.
const NIGHT_WINDOW_MS = 3 * 60 * MINUTE_MS;
const SKIP_RETRY_MS = 15 * MINUTE_MS;
const CONTINUE_AFTER_MS = 60 * MINUTE_MS;
const PAUSE_MS = 500;
const GIT_TIMEOUT_MS = 120_000;

export type GcTrigger = "nightly" | "idle" | "manual";

export interface GcRunSummary {
  id: string;
  trigger: GcTrigger;
  mode: "dry-run" | "apply";
  startedAt: string;
  finishedAt: string;
  // Removed — or, in a dry run, what would be.
  worktrees: number;
  bytes: number;
  agents: number;
  trash: number;
  files: number;
  kept: Partial<Record<KeptKind, number>>;
  owned: number;
  // Candidates not inspected because the sweep stopped early, and why.
  uninspected: number;
  stopped?: string;
}

export interface AutoGcState {
  paused?: { at: string };
  // The policy version whose dry run has happened; runs apply only once it
  // matches GC_POLICY_VERSION.
  armedPolicy?: number;
  lastRun?: GcRunSummary;
  lastSkip?: { at: string; reason: string };
  // A sweep that exited abnormally; no retry until the next night's window.
  lastFailure?: { at: string; code: number | null };
}

export function readAutoGcState(): AutoGcState {
  const state = readJsonOrNull<AutoGcState>(gcStateFile());
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

export function updateAutoGcState(change: (state: AutoGcState) => void): AutoGcState {
  mkdirSync(dirname(gcStateFile()), { recursive: true });
  return withFileLock(`${gcStateFile()}.lock`, () => {
    const state = readAutoGcState();
    change(state);
    writeJsonAtomic(gcStateFile(), state);
    return state;
  });
}

export function autoGcArmed(state: AutoGcState): boolean {
  return state.armedPolicy === GC_POLICY_VERSION;
}

function quietHour(config: Pick<Config, "gcAutoHour">): number {
  return Math.floor(configNumber(config.gcAutoHour, 4, 0, 23));
}

function maxMinutes(config: Pick<Config, "gcAutoMaxMinutes">): number {
  return configNumber(config.gcAutoMaxMinutes, 15, 1);
}

function windowStart(now: Date, config: Pick<Config, "gcAutoHour">): Date {
  const start = new Date(now);
  start.setHours(quietHour(config), 0, 0, 0);
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

// Whether the daemon should start a sweep now. One sweep per night: at the
// quiet hour, or — when that was missed or the host was too busy — as soon as
// no agent is working. A sweep cut short continues once the fleet is idle.
export function autoGcDue(
  now: Date,
  state: AutoGcState,
  config: Pick<Config, "gcAuto" | "gcAutoHour">,
  busy: boolean,
): { trigger: GcTrigger } | null {
  if (config.gcAuto !== true || state.paused) return null;
  const nowMs = now.getTime();
  const skippedAt = state.lastSkip ? Date.parse(state.lastSkip.at) : NaN;
  if (Number.isFinite(skippedAt) && nowMs - skippedAt < SKIP_RETRY_MS) return null;
  const opened = windowStart(now, config).getTime();
  // A sweep that keeps failing would otherwise be relaunched every minute.
  if (state.lastFailure && !(Date.parse(state.lastFailure.at) < opened)) return null;
  const last = state.lastRun ? Date.parse(state.lastRun.finishedAt) : NaN;
  if (Number.isFinite(last) && last >= opened) {
    return state.lastRun!.uninspected > 0 && !busy && nowMs - last > CONTINUE_AFTER_MS ? { trigger: "idle" } : null;
  }
  if (nowMs - opened < NIGHT_WINDOW_MS) return { trigger: "nightly" };
  return busy ? null : { trigger: "idle" };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const KEPT_LABELS: [KeptKind, string][] = [
  ["dirty", "dirty"], ["unpushed", "unpushed"], ["recent", "recent"], ["marker", "marked keep"], ["lease", "leased"], ["other", "other"],
];

// "freed 12 worktrees (9.1 GB), reaped 2 agents; kept 3 dirty, 1 unpushed"
export function formatGcSummary(run: GcRunSummary): string {
  const dry = run.mode === "dry-run";
  const parts: string[] = [];
  if (run.worktrees > 0) parts.push(`${dry ? "free" : "freed"} ${count(run.worktrees, "worktree")}${run.bytes > 0 ? ` (${formatBytes(run.bytes)})` : ""}`);
  if (run.agents > 0) parts.push(`${dry ? "reap" : "reaped"} ${count(run.agents, "agent")}`);
  if (run.trash > 0) parts.push(`${dry ? "purge" : "purged"} ${count(run.trash, "trash snapshot")}`);
  if (run.files > 0) parts.push(`${dry ? "remove" : "removed"} ${count(run.files, "old file")}`);
  const kept = KEPT_LABELS.filter(([kind]) => run.kept[kind]).map(([kind, label]) => `${run.kept[kind]} ${label}`);
  let text = parts.length > 0 ? `${dry ? "dry run, would " : ""}${parts.join(", ")}` : dry ? "dry run, nothing to collect" : "nothing to collect";
  if (kept.length > 0) text += `; kept ${kept.join(", ")}`;
  if (run.stopped) text += `; stopped early (${run.stopped}, ${run.uninspected} not inspected)`;
  return text;
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function failedSinceLastRun(state: AutoGcState): boolean {
  return !!state.lastFailure && !(Date.parse(state.lastFailure.at) < Date.parse(state.lastRun?.finishedAt ?? ""));
}

// One line for `am summary` and the hub, or null before the first run.
export function gcSummaryLine(now: number = Date.now()): string | null {
  const state = readAutoGcState();
  const failed = failedSinceLastRun(state) ? ` · last sweep failed ${ago(state.lastFailure!.at, now)}` : "";
  if (!state.lastRun) return state.paused ? `paused${failed}` : failed ? failed.slice(3) : null;
  return `${formatGcSummary(state.lastRun)} · ${ago(state.lastRun.finishedAt, now)}${failed}${state.paused ? " · paused" : ""}`;
}

export interface AutoGcRunOptions {
  trigger: GcTrigger;
  // Report only, whatever the state says.
  dryRun?: boolean;
  // Run despite load and pressure.
  force?: boolean;
  config?: Config;
  pressure?: () => Pressure;
  sleep?: (ms: number) => void;
  prHead?: (url: string) => string | null;
}

export type AutoGcResult = { summary: GcRunSummary } | { skipped: string };

// One sweep. Safe to call from anywhere: it holds the gc lock for its whole
// run and gives up at once when another gc has it.
export function runAutoGc(opts: AutoGcRunOptions): AutoGcResult {
  // Reaps are audited as the daemon's; a manual run keeps its caller's context.
  if (opts.trigger !== "manual") return withAuditContext({ source: "daemon", route: "auto-gc" }, () => sweep(opts));
  return sweep(opts);
}

function sweep(opts: AutoGcRunOptions): AutoGcResult {
  const release = acquireGcLock();
  if (!release) return { skipped: "another gc is running" };
  try {
    const config = opts.config ?? loadConfig();
    const pressure = opts.pressure ?? readPressure;
    const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));
    const busy = () => (opts.force ? null : pressureReason(pressure(), config));

    const waiting = busy();
    if (waiting) {
      updateAutoGcState((state) => { state.lastSkip = { at: new Date().toISOString(), reason: waiting }; });
      return { skipped: waiting };
    }

    const before = readAutoGcState();
    const mode = opts.dryRun || !autoGcArmed(before) ? "dry-run" : "apply";
    const started = Date.now();
    const run = started.toString(36);
    const policy = { ...gcPolicy(config), gitTimeoutMs: GIT_TIMEOUT_MS, ...(opts.prHead ? { prHead: opts.prHead } : {}) };
    const context = { source: "auto" as const, run, measure: true };
    const summary: GcRunSummary = {
      id: run, trigger: opts.trigger, mode, startedAt: new Date(started).toISOString(), finishedAt: "",
      worktrees: 0, bytes: 0, agents: 0, trash: 0, files: 0, kept: {}, owned: 0, uninspected: 0,
    };
    const note = (entry: Pick<GcLogEntry, "action"> & Partial<GcLogEntry>) => logGc({ source: "auto", mode, run, ...entry });
    const keep = (kept: KeptWorktree) => {
      summary.kept[kept.kind] = (summary.kept[kept.kind] ?? 0) + 1;
      note({ action: "keep-worktree", path: kept.path, reason: kept.reason });
    };

    // Agents, trash and stray files: am's own records, no git, no pacing needed.
    const plan = planGc(policy, { worktrees: false });
    if (mode === "apply") {
      const lines = applyGc(plan, policy, context);
      summary.agents = lines.filter((line) => line.startsWith("reaped agent")).length;
      summary.trash = lines.filter((line) => line.startsWith("purged trash")).length;
      summary.files = lines.filter((line) => /^removed (old|orphaned) /.test(line)).length;
    } else {
      for (const agent of plan.agents) note({ action: "reap-agent", name: agent.name, path: agent.dir });
      for (const trashed of plan.trash) note({ action: "purge-trash", name: trashed.name });
      for (const orphan of plan.orphans) note({ action: "remove-file", path: orphan.path, reason: orphan.kind });
      summary.agents = plan.agents.length;
      summary.trash = plan.trash.length;
      summary.files = plan.orphans.length;
    }

    // Worktrees. In a dry run the agents above are still registered; the
    // judge is told they are about to be reaped so the report matches what
    // the applying run will do.
    const judge = new WorktreeJudge(policy, started, mode === "apply" ? [] : plan.agents);
    const candidates = listWorktreeCandidates();
    const pending = [];
    for (const candidate of candidates) {
      const cheap = judge.cheap(candidate);
      if (cheap === "owned") summary.owned++;
      else if (cheap) keep(cheap);
      else pending.push(candidate);
    }
    const queue = judge.inspectionOrder(pending);

    const deadline = started + maxMinutes(config) * MINUTE_MS;
    for (const [index, candidate] of queue.entries()) {
      // Pause first, so the readings below are from just before the git work.
      if (index > 0) sleep(PAUSE_MS);
      const stop = awaitQuiet(deadline, busy, sleep);
      if (stop) {
        summary.stopped = stop;
        summary.uninspected = queue.length - index;
        break;
      }
      const result = judge.inspect(candidate);
      if ("kept" in result) {
        keep(result.kept);
      } else if (mode === "dry-run") {
        const bytes = diskBytes(candidate.path);
        note({
          action: "remove-worktree", path: candidate.path, repoRoot: result.remove.repoRoot,
          ...(result.remove.salvage ? { reason: result.remove.salvage } : {}), ...(bytes !== undefined ? { bytes } : {}),
        });
        summary.worktrees++;
        summary.bytes += bytes ?? 0;
      } else {
        const removal = removeWorktree(result.remove, policy, context);
        if (removal.removed) {
          summary.worktrees++;
          summary.bytes += removal.bytes ?? 0;
        } else if (removal.kept) {
          keep(removal.kept);
        }
      }
    }

    judge.saveInspections(candidates);
    summary.finishedAt = new Date().toISOString();
    updateAutoGcState((state) => {
      state.lastRun = summary;
      delete state.lastSkip;
      delete state.lastFailure;
      // Only a dry run that reached every worktree has shown what this policy
      // collects; one cut short is continued as a dry run.
      if (!summary.stopped && summary.uninspected === 0) state.armedPolicy = GC_POLICY_VERSION;
    });
    return { summary };
  } finally {
    release();
  }
}

function niceCommand(): string[] {
  return [
    ...(Bun.which("nice") ? ["nice", "-n", "19"] : []),
    // Lowest best-effort IO priority, not the idle class: starved behind every
    // other reader, one `git status` of a large checkout took minutes instead
    // of seconds and timed out having made no progress. The pacing and the
    // pressure back-off are what keep the sweep out of the way.
    ...(Bun.which("ionice") ? ["ionice", "-c", "2", "-n", "7"] : []),
  ];
}

// The daemon's side: a once-a-minute check that starts the sweep as its own
// process when one is due and the host is quiet.
export function startAutoGc(log: (message: string) => void): { stop(): void } {
  let running = false;
  const tick = () => {
    if (running) return;
    try {
      const config = loadConfig();
      if (config.gcAuto !== true) return;
      const state = readAutoGcState();
      const due = autoGcDue(new Date(), state, config, listAgents().some((agent) => agent.status === "working"));
      if (!due) return;
      const waiting = pressureReason(readPressure(), config);
      if (waiting) {
        updateAutoGcState((current) => { current.lastSkip = { at: new Date().toISOString(), reason: waiting }; });
        log(`gc: ${due.trigger} sweep waits — ${waiting}`);
        return;
      }
      running = true;
      const child = Bun.spawn({
        cmd: [...niceCommand(), process.execPath, cliEntrypoint(), "__gc-auto", due.trigger],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
        // The sweep acts for the daemon, not for whoever started the daemon.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["AGENTMGR_AGENT", "SSH_CONNECTION", "SSH_CLIENT"].includes(key))),
      });
      log(`gc: ${due.trigger} sweep started (pid ${child.pid})`);
      void child.exited.then((code) => {
        running = false;
        if (code !== 0) {
          try { updateAutoGcState((current) => { current.lastFailure = { at: new Date().toISOString(), code }; }); }
          catch (error) { log(`gc: could not record the failure: ${error}`); }
          log(`gc: sweep exited with ${code}; next attempt in tomorrow's window`);
          return;
        }
        const last = readAutoGcState().lastRun;
        if (last) log(`gc: ${formatGcSummary(last)}`);
      });
    } catch (error) {
      running = false;
      log(`gc: scheduler failed: ${error}`);
    }
  };
  const timer = setInterval(tick, TICK_MS);
  return { stop: () => clearInterval(timer) };
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function autoGcStatus(config: Config = loadConfig(), now: Date = new Date()): string[] {
  const state = readAutoGcState();
  const lines: string[] = [];
  const hour = `${String(quietHour(config)).padStart(2, "0")}:00`;
  if (config.gcAuto !== true) lines.push("auto gc: off (gcAuto is not true in config.json)");
  else if (state.paused) lines.push(`auto gc: paused ${ago(state.paused.at, now.getTime())} — \`am gc --auto resume\` turns it back on`);
  else lines.push(`auto gc: on — nightly at ${hour} or when the fleet is next idle, up to ${maxMinutes(config)}m a run`);
  lines.push(autoGcArmed(state)
    ? "mode: apply"
    : "mode: dry run — the next sweep only reports; the ones after it apply");
  if (state.lastRun) {
    const run = state.lastRun;
    const seconds = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
    lines.push(`last run: ${ago(run.finishedAt, now.getTime())} (${run.trigger}, ${seconds}s) — ${formatGcSummary(run)}; ${run.owned} owned by agents`);
    const worktrees = readGcLog().filter((entry) => entry.run === run.id && entry.action === "remove-worktree" && entry.path);
    for (const entry of worktrees.slice(0, 30)) {
      const size = entry.bytes !== undefined ? ` (${formatBytes(entry.bytes)})` : "";
      lines.push(`  ${run.mode === "dry-run" ? "would remove" : "removed"} ${entry.path}${size}${entry.reason ? ` — ${entry.reason}` : ""}`);
    }
    if (worktrees.length > 30) lines.push(`  … and ${worktrees.length - 30} more`);
  } else {
    lines.push("last run: never");
  }
  if (state.lastSkip) lines.push(`last skip: ${ago(state.lastSkip.at, now.getTime())} — ${state.lastSkip.reason}`);
  if (failedSinceLastRun(state)) {
    lines.push(`last failure: ${ago(state.lastFailure!.at, now.getTime())} — the sweep exited with ${state.lastFailure!.code}; see the daemon log`);
  }
  if (config.gcAuto === true && !state.paused) {
    const pressure = pressureReason(readPressure(), config);
    const opened = windowStart(now, config);
    const ranTonight = state.lastRun && Date.parse(state.lastRun.finishedAt) >= opened.getTime();
    const next = new Date(opened);
    next.setDate(next.getDate() + 1);
    const inWindow = now.getTime() - opened.getTime() < NIGHT_WINDOW_MS;
    const failedTonight = state.lastFailure && !(Date.parse(state.lastFailure.at) < opened.getTime());
    lines.push(failedTonight
      ? `next: ${clock(next)} (held back after the failure)`
      : ranTonight
      ? `next: ${clock(next)}${state.lastRun!.uninspected > 0 ? ", or sooner to finish the last sweep once the fleet is idle" : ""}`
      : `next: ${inWindow ? "within minutes" : "as soon as no agent is working"}${pressure ? `, once the host is quieter (now: ${pressure})` : ""}`);
  }
  lines.push(`log: ${gcLogFile()}`);
  return lines;
}
