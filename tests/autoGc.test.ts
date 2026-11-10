import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GC_POLICY_VERSION, autoGcDue, autoGcStatus, formatGcSummary, gcSummaryLine, readAutoGcState, runAutoGc, updateAutoGcState,
  type AutoGcState, type GcRunSummary,
} from "../src/autoGc";
import { awaitQuiet, pressureReason, type Pressure } from "../src/pressure";
import { gcAutoCommand } from "../src/commands/gc";
import { loadConfig } from "../src/config";
import { acquireGcLock, readGcLog } from "../src/gc";
import { buildFleetSummary, formatFleetSummary } from "../src/summary";
import { readAgent, writeAgent, type AgentState } from "../src/state";

let home: string, repo: string;
let oldHome: string | undefined, oldPool: string | undefined;
const DAY = 86_400_000;
const CALM: Pressure = { loadPerCpu: 0.1, io: 1, memory: 0 };
const quiet = { pressure: () => CALM, sleep: () => {} };

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function idle(path: string, days = 10): void {
  const admin = git(path, "rev-parse", "--absolute-git-dir");
  const t = (Date.now() - days * DAY) / 1000;
  const reflog = join(admin, "logs", "HEAD");
  writeFileSync(reflog, readFileSync(reflog, "utf8").replaceAll(/> \d+ ([+-]\d{4})/g, `> ${Math.floor(t)} $1`));
  for (const target of [path, join(admin, "HEAD")]) utimesSync(target, t, t);
}

function addWorktree(name: string): string {
  const path = join(home, "worktrees", "repo", name);
  mkdirSync(join(home, "worktrees", "repo"), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", `am/${name}`, path);
  idle(path);
  return path;
}

function agent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return { name, status: "exited", dir: home, tmuxSession: `agentmgr-auto-gc-${name}`, createdAt: now, updatedAt: now, ...extra };
}

function run(extra: Partial<GcRunSummary> = {}): GcRunSummary {
  return {
    id: "r", trigger: "nightly", mode: "apply", startedAt: "2026-11-10T04:00:00.000Z", finishedAt: "2026-11-10T04:02:00.000Z",
    worktrees: 0, bytes: 0, agents: 0, trash: 0, files: 0, kept: {}, owned: 0, uninspected: 0, ...extra,
  };
}

// Local time, like the scheduler's quiet hour.
function at(hour: number, minute = 0, dayOffset = 0): Date {
  const date = new Date(2026, 10, 10 + dayOffset, hour, minute, 0, 0);
  return date;
}

beforeEach(() => {
  oldHome = process.env.AGENTMGR_HOME;
  oldPool = process.env.DEV_POOL_ROOT;
  home = mkdtempSync(join(tmpdir(), "am-auto-gc-"));
  process.env.AGENTMGR_HOME = home;
  process.env.DEV_POOL_ROOT = join(home, "pool");
  repo = join(home, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTMGR_HOME; else process.env.AGENTMGR_HOME = oldHome;
  if (oldPool === undefined) delete process.env.DEV_POOL_ROOT; else process.env.DEV_POOL_ROOT = oldPool;
});

describe("autoGcDue", () => {
  const config = { gcAuto: true, gcAutoHour: 4 };
  const ranAt = (date: Date, extra: Partial<GcRunSummary> = {}): AutoGcState => ({ lastRun: run({ finishedAt: date.toISOString(), ...extra }) });

  test("runs nightly at the quiet hour, once", () => {
    const last = ranAt(at(4, 5, -1));
    expect(autoGcDue(at(3, 59), last, config, false)).toBeNull();
    expect(autoGcDue(at(4, 1), last, config, true)).toEqual({ trigger: "nightly" });
    expect(autoGcDue(at(4, 30), ranAt(at(4, 5)), config, false)).toBeNull();
    expect(autoGcDue(at(23, 0), ranAt(at(4, 5)), config, false)).toBeNull();
  });

  test("a missed night is caught up only when no agent is working", () => {
    const last = ranAt(at(4, 5, -1));
    expect(autoGcDue(at(9, 0), last, config, true)).toBeNull();
    expect(autoGcDue(at(9, 0), last, config, false)).toEqual({ trigger: "idle" });
    // Never ran (just upgraded): the same rule.
    expect(autoGcDue(at(15, 0), {}, config, true)).toBeNull();
    expect(autoGcDue(at(15, 0), {}, config, false)).toEqual({ trigger: "idle" });
  });

  test("off, paused, and a recent skip all hold it back", () => {
    expect(autoGcDue(at(4, 1), {}, { ...config, gcAuto: false }, false)).toBeNull();
    expect(autoGcDue(at(4, 1), { paused: { at: at(1).toISOString() } }, config, false)).toBeNull();
    const skipped = { lastSkip: { at: at(4, 0).toISOString(), reason: "load" } };
    expect(autoGcDue(at(4, 10), skipped, config, false)).toBeNull();
    expect(autoGcDue(at(4, 20), skipped, config, false)).toEqual({ trigger: "nightly" });
  });

  test("a sweep cut short continues when idle, an hour later at the earliest", () => {
    const cut = ranAt(at(4, 15), { uninspected: 12, stopped: "time budget" });
    expect(autoGcDue(at(4, 45), cut, config, false)).toBeNull();
    expect(autoGcDue(at(5, 30), cut, config, true)).toBeNull();
    expect(autoGcDue(at(5, 30), cut, config, false)).toEqual({ trigger: "idle" });
  });
});

describe("pressure", () => {
  const limits = { gcAutoMaxLoad: 1, gcAutoMaxPressure: 20 };
  test("load, IO and memory pressure each hold the sweep; missing PSI does not", () => {
    expect(pressureReason(CALM, limits)).toBeNull();
    expect(pressureReason({ loadPerCpu: 0.5, io: null, memory: null }, limits)).toBeNull();
    expect(pressureReason({ ...CALM, loadPerCpu: 5.6 }, limits)).toContain("load 5.60");
    expect(pressureReason({ ...CALM, io: 90 }, limits)).toContain("IO pressure 90%");
    expect(pressureReason({ ...CALM, memory: 45 }, limits)).toContain("memory pressure 45%");
  });
});

describe("awaitQuiet", () => {
  test("goes ahead when calm, waits while busy, and gives the reason once the deadline is too near", () => {
    const sleeps: number[] = [];
    expect(awaitQuiet(Date.now() + 60_000, () => null, (ms) => sleeps.push(ms))).toBeNull();
    let busy = 2;
    expect(awaitQuiet(Date.now() + 60_000, () => (busy-- > 0 ? "busy" : null), (ms) => sleeps.push(ms))).toBeNull();
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(awaitQuiet(Date.now() + 5_000, () => "IO pressure", () => { throw new Error("no time to wait"); })).toBe("IO pressure");
    expect(awaitQuiet(Date.now() - 1, () => null, () => {})).toBe("time budget");
  });
});

describe("runAutoGc", () => {
  test("the first run only reports; the second applies and logs what it removed", () => {
    const wt = addWorktree("orphan");
    const dirty = addWorktree("dirty");
    writeFileSync(join(dirty, "wip.txt"), "wip\n");
    idle(dirty);
    const owned = addWorktree("owned");
    writeAgent(agent("owned", { dir: owned, worktreePath: owned, status: "idle" }));

    const first = runAutoGc({ trigger: "nightly", ...quiet });
    if (!("summary" in first)) throw new Error("skipped");
    expect(first.summary.mode).toBe("dry-run");
    expect(first.summary.worktrees).toBe(1);
    expect(first.summary.kept).toEqual({ dirty: 1 });
    expect(first.summary.owned).toBe(1);
    expect(existsSync(wt)).toBe(true);
    expect(readAutoGcState().armedPolicy).toBe(GC_POLICY_VERSION);
    expect(readGcLog().filter((e) => e.action === "remove-worktree").map((e) => [e.mode, e.path])).toEqual([["dry-run", wt]]);

    const second = runAutoGc({ trigger: "nightly", ...quiet });
    if (!("summary" in second)) throw new Error("skipped");
    expect(second.summary.mode).toBe("apply");
    expect(second.summary.worktrees).toBe(1);
    expect(second.summary.bytes).toBeGreaterThan(0);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(owned)).toBe(true);
    const removal = readGcLog().find((e) => e.action === "remove-worktree" && e.mode === "apply")!;
    expect(removal.branch).toBe("am/orphan");
    expect(removal.head).toMatch(/^[a-f0-9]{40}$/);
    expect(readAutoGcState().lastRun?.id).toBe(second.summary.id);
  });

  test("--dry-run reports even once armed; a policy bump goes back to a dry run", () => {
    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION; });
    const wt = addWorktree("orphan");
    const dry = runAutoGc({ trigger: "manual", dryRun: true, ...quiet });
    expect("summary" in dry && dry.summary.mode).toBe("dry-run");
    expect(existsSync(wt)).toBe(true);

    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION - 1; });
    const after = runAutoGc({ trigger: "nightly", ...quiet });
    expect("summary" in after && after.summary.mode).toBe("dry-run");
    expect(existsSync(wt)).toBe(true);
  });

  test("a busy host skips the sweep without touching anything, unless forced", () => {
    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION; });
    const wt = addWorktree("orphan");
    const busy = { pressure: () => ({ ...CALM, io: 90 }), sleep: () => {} };
    const skipped = runAutoGc({ trigger: "nightly", ...busy });
    expect(skipped).toEqual({ skipped: "IO pressure 90% (limit 20%)" });
    expect(readAutoGcState().lastSkip?.reason).toContain("IO pressure");
    expect(readAutoGcState().lastRun).toBeUndefined();
    expect(existsSync(wt)).toBe(true);

    const forced = runAutoGc({ trigger: "manual", force: true, ...busy });
    expect("summary" in forced && forced.summary.worktrees).toBe(1);
    expect(existsSync(wt)).toBe(false);
    expect(readAutoGcState().lastSkip).toBeUndefined();
  });

  // A clock the sweep's sleeps advance, so waiting out pressure takes no real time.
  function fakeClock<T>(body: (sleep: (ms: number) => void, elapsed: () => number) => T): T {
    const realNow = Date.now;
    const start = realNow();
    let clock = start;
    Date.now = () => clock;
    try {
      return body((ms) => { clock += ms; }, () => clock - start);
    } finally {
      Date.now = realNow;
    }
  }

  test("pressure that stays high ends the sweep at its budget; the next run starts with what it missed", () => {
    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION; });
    const paths = [addWorktree("a"), addWorktree("b"), addWorktree("c")];
    let checks = 0;
    // Calm at the start and for the first worktree, then busy for good.
    const pressure = () => (++checks > 2 ? { ...CALM, loadPerCpu: 9 } : CALM);
    const cut = fakeClock((sleep) => runAutoGc({ trigger: "nightly", pressure, sleep }));
    if (!("summary" in cut)) throw new Error("skipped");
    expect(cut.summary.worktrees).toBe(1);
    expect(cut.summary.uninspected).toBe(2);
    expect(cut.summary.stopped).toContain("load");
    expect(paths.filter((p) => existsSync(p))).toHaveLength(2);
    expect(formatGcSummary(cut.summary)).toContain("stopped early");

    const rest = runAutoGc({ trigger: "idle", ...quiet });
    expect("summary" in rest && rest.summary.worktrees).toBe(2);
    expect("summary" in rest && rest.summary.uninspected).toBe(0);
  });

  test("pressure that passes only delays the sweep", () => {
    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION; });
    addWorktree("a");
    addWorktree("b");
    let checks = 0;
    // Busy for three readings after the first worktree — as its own reads would make it.
    const pressure = () => { checks++; return checks >= 3 && checks <= 5 ? { ...CALM, io: 80 } : CALM; };
    const result = fakeClock((sleep, elapsed) => ({ run: runAutoGc({ trigger: "nightly", pressure, sleep }), waited: elapsed() }));
    if (!("summary" in result.run)) throw new Error("skipped");
    expect(result.run.summary.worktrees).toBe(2);
    expect(result.run.summary.stopped).toBeUndefined();
    expect(result.waited).toBeGreaterThanOrEqual(30_000);
  });

  test("the time budget ends a sweep between worktrees", () => {
    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION; });
    addWorktree("a");
    addWorktree("b");
    const config = { ...loadConfig(), gcAutoMaxMinutes: 1 };
    // Each pause between worktrees "takes" two minutes.
    const result = fakeClock((sleep) => runAutoGc({ trigger: "nightly", config, pressure: () => CALM, sleep: () => sleep(120_000) }));
    if (!("summary" in result)) throw new Error("skipped");
    expect(result.summary.worktrees).toBe(1);
    expect(result.summary.stopped).toBe("time budget");
    expect(result.summary.uninspected).toBe(1);
  });

  test("never overlaps another gc", () => {
    const wt = addWorktree("orphan");
    updateAutoGcState((state) => { state.armedPolicy = GC_POLICY_VERSION; });
    const release = acquireGcLock()!;
    try {
      expect(runAutoGc({ trigger: "nightly", ...quiet })).toEqual({ skipped: "another gc is running" });
      expect(acquireGcLock()).toBeNull();
    } finally {
      release();
    }
    expect(existsSync(wt)).toBe(true);
    expect("summary" in runAutoGc({ trigger: "nightly", ...quiet })).toBe(true);
  });

  test("reaps and files follow the mode too", () => {
    writeAgent(agent("old"));
    const file = join(home, "agents", "old.json");
    writeFileSync(file, JSON.stringify({ ...readAgent("old")!, updatedAt: new Date(Date.now() - 10 * DAY).toISOString() }));
    const dry = runAutoGc({ trigger: "nightly", ...quiet });
    expect("summary" in dry && dry.summary.agents).toBe(1);
    expect(readAgent("old")).not.toBeNull();
    const applied = runAutoGc({ trigger: "nightly", ...quiet });
    expect("summary" in applied && applied.summary.agents).toBe(1);
    expect(readAgent("old")).toBeNull();
    expect(formatGcSummary((applied as { summary: GcRunSummary }).summary)).toBe("reaped 1 agent");
  });
});

describe("reporting", () => {
  test("summary lines read like a sentence", () => {
    expect(formatGcSummary(run({ worktrees: 12, bytes: 9.1e9, kept: { dirty: 3 } }))).toBe("freed 12 worktrees (9.1 GB); kept 3 dirty");
    expect(formatGcSummary(run({ mode: "dry-run", worktrees: 1, bytes: 4.2e8, agents: 2, kept: { unpushed: 1, recent: 4 } })))
      .toBe("dry run, would free 1 worktree (420 MB), reap 2 agents; kept 1 unpushed, 4 recent");
    expect(formatGcSummary(run())).toBe("nothing to collect");
  });

  test("am summary carries the last run; pause and resume show in status", () => {
    expect(gcSummaryLine()).toBeNull();
    updateAutoGcState((state) => { state.lastRun = run({ worktrees: 2, bytes: 3e9, finishedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }); });
    expect(gcSummaryLine()).toBe("freed 2 worktrees (3.0 GB) · 2h ago");
    const summary = buildFleetSummary({ rows: [], unreachable: [] } as never, new Date(), gcSummaryLine());
    expect(formatFleetSummary(summary).at(-1)).toBe("gc: freed 2 worktrees (3.0 GB) · 2h ago");

    const log = console.log;
    console.log = () => {};
    try {
      gcAutoCommand("pause");
      expect(readAutoGcState().paused).toBeDefined();
      expect(autoGcStatus()[0]).toContain("paused");
      expect(gcSummaryLine()).toEndWith("· paused");
      expect(autoGcDue(new Date(), readAutoGcState(), { gcAuto: true, gcAutoHour: 4 }, false)).toBeNull();
      gcAutoCommand("resume");
      expect(readAutoGcState().paused).toBeUndefined();
      expect(() => gcAutoCommand("bogus")).toThrow("unknown");
    } finally {
      console.log = log;
    }
    const status = autoGcStatus();
    expect(status[0]).toContain("auto gc: on — nightly at 04:00");
    expect(status[1]).toContain("dry run");
    expect(status.join("\n")).toContain("last run: 2h ago");
  });
});
