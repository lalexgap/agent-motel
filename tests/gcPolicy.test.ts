import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyGc, gcPolicy, planGc, readGcLog, restoreWorktree, type GcOptions, type GcPlan } from "../src/gc";
import { loadConfig } from "../src/config";
import { destroyAgent } from "../src/commands/rm";
import { restoreCommand } from "../src/commands/restore";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { readTrashedState, trashState } from "../src/trash";
import { KEEP_MARKER, managedWorktreeRoot, noteWorkDir, salvageWorktree } from "../src/worktreeOwnership";

let home: string, repo: string, origin: string;
let oldHome: string | undefined, oldPool: string | undefined;
const DAY = 86_400_000;

const POLICY: GcOptions = { agentDays: 7, trashDays: 30, mergedDays: 3, removedDays: 7, orphanDays: 3, staleDays: 30, fileDays: 30 };

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

function agent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return { name, status: "exited", dir: home, tmuxSession: `agentmgr-gc-policy-${name}`, createdAt: now, updatedAt: now, ...extra };
}

// writeAgent stamps updatedAt = now, so backdate by rewriting the file.
function backdateAgent(name: string, days: number): void {
  writeFileSync(join(home, "agents", `${name}.json`), JSON.stringify({ ...readAgent(name)!, updatedAt: daysAgo(days) }, null, 2) + "\n");
}

function trash(state: AgentState, days: number): void {
  trashState(state);
  const file = join(home, "trash", `${state.name}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), trashedAt: daysAgo(days) }));
}

function addWorktree(name: string, dir = join(home, "worktrees", "repo", name)): string {
  mkdirSync(resolve(dir, ".."), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", `am/${name}`, dir);
  return dir;
}

function touch(path: string, days: number): void {
  const t = (Date.now() - days * DAY) / 1000;
  utimesSync(path, t, t);
}

// Age everything gc reads as activity: the checkout's root and its HEAD log.
function idle(path: string, days: number, ...files: string[]): void {
  const admin = git(path, "rev-parse", "--absolute-git-dir");
  for (const file of files) touch(join(path, file), days);
  const reflog = join(admin, "logs", "HEAD");
  const then = Math.floor((Date.now() - days * DAY) / 1000);
  writeFileSync(reflog, readFileSync(reflog, "utf8").replaceAll(/> \d+ ([+-]\d{4})/g, `> ${then} $1`));
  for (const target of [path, join(admin, "HEAD")]) touch(target, days);
}

function commit(path: string, file = "work.txt"): string {
  writeFileSync(join(path, file), "work\n");
  git(path, "add", file);
  git(path, "commit", "-q", "-m", `add ${file}`);
  return git(path, "rev-parse", "HEAD");
}

function merged(daysSince: number) {
  return { pullRequests: [{ repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED" as const, mergedAt: daysAgo(daysSince), mergeCommit: "a".repeat(40), updatedAt: daysAgo(daysSince) }] };
}

beforeEach(() => {
  oldHome = process.env.AGENTMGR_HOME;
  oldPool = process.env.DEV_POOL_ROOT;
  home = mkdtempSync(join(tmpdir(), "am-gc-policy-"));
  process.env.AGENTMGR_HOME = home;
  process.env.DEV_POOL_ROOT = join(home, "pool");
  origin = join(home, "origin.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", origin]);
  repo = join(home, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTMGR_HOME; else process.env.AGENTMGR_HOME = oldHome;
  if (oldPool === undefined) delete process.env.DEV_POOL_ROOT; else process.env.DEV_POOL_ROOT = oldPool;
});

describe("ownership of worktrees an agent is not registered in", () => {
  test("a home-registered agent owns the worktree named after it, live or exited", () => {
    const wt = addWorktree("ad-form");
    idle(wt, 10);
    writeAgent(agent("ad-form", { dir: home }));
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.ownedWorktrees).toBe(1);
  });

  test("an alias owns the worktree too", () => {
    const wt = addWorktree("old-name");
    idle(wt, 10);
    writeAgent(agent("new-name", { aliases: ["old-name"] }));
    expect(planGc(POLICY).worktrees).toEqual([]);
  });

  test("the hook's cwd is recorded and protects a differently named worktree", () => {
    const wt = addWorktree("scratch");
    idle(wt, 10);
    const state = agent("roamer");
    expect(noteWorkDir(state, join(wt, "frontend", "app"))).toBe(true);
    expect(state.workDirs).toEqual([wt]);
    expect(noteWorkDir(state, wt)).toBe(false);
    writeAgent(state);
    expect(planGc(POLICY).worktrees).toEqual([]);

    // Without the record nothing ties the agent to it.
    writeAgent({ ...readAgent("roamer")!, workDirs: undefined });
    expect(planGc(POLICY).worktrees.map((w) => w.path)).toEqual([wt]);
  });

  test("a worktree worked in again moves to the end, so the cap drops the oldest", () => {
    const state = agent("busy");
    const dirs = Array.from({ length: 17 }, (_, i) => join(home, "worktrees", "repo", `w${i}`));
    noteWorkDir(state, dirs[0]!);
    for (const dir of dirs.slice(1, 16)) noteWorkDir(state, dir);
    expect(noteWorkDir(state, dirs[15]!)).toBe(false);
    expect(noteWorkDir(state, dirs[0]!)).toBe(true);
    noteWorkDir(state, dirs[16]!);
    expect(state.workDirs).toHaveLength(16);
    expect(state.workDirs).toContain(dirs[0]!);
    expect(state.workDirs).not.toContain(dirs[1]!);
  });

  test("cwd outside the managed worktrees, or in the agent's own dir, is not recorded", () => {
    const wt = addWorktree("own");
    expect(noteWorkDir(agent("own", { dir: wt, worktreePath: wt }), join(wt, "src"))).toBe(false);
    expect(noteWorkDir(agent("elsewhere"), "/tmp/somewhere")).toBe(false);
    expect(managedWorktreeRoot(join(home, "worktrees", "repo"))).toBeNull();
    expect(managedWorktreeRoot(join(wt, ".claude", "worktrees", "agent-1", "src"))).toBe(join(wt, ".claude", "worktrees", "agent-1"));
  });

  test("a visit to another agent's worktree claims nothing: rm --clean and gc still take it", () => {
    const wt = addWorktree("visited");
    idle(wt, 10);
    const concierge = agent("concierge", { status: "idle" });
    noteWorkDir(concierge, join(wt, "src"));
    writeAgent(concierge);
    const owner = agent("visited", { dir: wt, worktreePath: wt, worktreeBranch: "am/visited", repoRoot: repo });
    writeAgent(owner);
    expect(planGc(POLICY).ownedWorktrees).toBe(1);

    const log = console.log;
    console.log = () => {};
    try { destroyAgent(readAgent("visited")!, { clean: true }); }
    finally { console.log = log; }
    expect(existsSync(wt)).toBe(false);

    // gc: a subagent worktree nested in a live agent's worktree is not the visitor's either.
    const host = addWorktree("visited-host");
    writeAgent(agent("visited-host", { dir: host, worktreePath: host, status: "idle" }));
    const sub = addWorktree("visited-sub", join(host, ".claude", "worktrees", "agent-1"));
    idle(sub, 10);
    noteWorkDir(concierge, sub);
    writeAgent(concierge);
    expect(planGc(POLICY).worktrees.map((w) => w.path)).toEqual([sub]);
  });

  test("an agent's main session in its own nested worktree still owns it", () => {
    const parent = addWorktree("nest-owner");
    const owner = agent("nest-owner", { dir: parent, worktreePath: parent, status: "idle" });
    const foo = addWorktree("nest-foo", join(parent, ".claude", "worktrees", "foo"));
    idle(foo, 10);
    expect(noteWorkDir(owner, join(foo, "src"))).toBe(true);
    writeAgent(owner);
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.ownedWorktrees).toBe(2);
  });

  test("an agent still working in a removed agent's worktree keeps it once the snapshot releases it", () => {
    const wt = addWorktree("handed-over");
    idle(wt, 10);
    trash(agent("handed-over", { dir: wt, worktreePath: wt, repoRoot: repo }), 8);
    const heir = agent("heir", { status: "idle" });
    noteWorkDir(heir, wt);
    writeAgent(heir);
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.ownedWorktrees).toBe(1);
  });

  test("a home-dir agent still owns a worktree it works in that no record is registered in", () => {
    const wt = addWorktree("made-by-concierge");
    idle(wt, 10);
    const concierge = agent("concierge", { status: "idle" });
    noteWorkDir(concierge, wt);
    writeAgent(concierge);
    expect(planGc(POLICY).worktrees).toEqual([]);
    expect(planGc(POLICY).ownedWorktrees).toBe(1);
  });

  test("a malformed workDirs keeps every worktree: ownership is unknown", () => {
    const wt = addWorktree("orphan");
    idle(wt, 10);
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "odd.json"), JSON.stringify({ ...agent("odd"), workDirs: "nope" }));
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees[0]!.reason).toContain("ownership information unavailable");
  });
});

describe("when a worktree is released", () => {
  test("a removed agent holds its worktree for removedDays, then gc takes it; restore recreates it", () => {
    const held = addWorktree("held");
    const released = addWorktree("released");
    idle(held, 10);
    idle(released, 10);
    trash(agent("held", { dir: held, worktreePath: held, worktreeBranch: "am/held", repoRoot: repo }), 2);
    trash(agent("released", { dir: released, worktreePath: released, worktreeBranch: "am/released", repoRoot: repo }), 8);

    const plan = planGc(POLICY);
    expect(plan.worktrees.map((w) => w.path)).toEqual([released]);
    applyGc(plan, POLICY);
    expect(existsSync(released)).toBe(false);
    expect(existsSync(held)).toBe(true);
    // The snapshot outlives the worktree: `am restore` recreates it from the branch.
    expect(readTrashedState("released")?.worktreeBranch).toBe("am/released");
    expect(git(repo, "branch", "--list", "am/released")).toContain("am/released");
  });

  test("an exited agent whose pull requests merged is reaped early and its worktree goes in the same run", () => {
    const wt = addWorktree("shipped");
    idle(wt, 5);
    writeAgent(agent("shipped", { dir: wt, worktreePath: wt, worktreeBranch: "am/shipped", repoRoot: repo, prMonitor: merged(4) }));
    backdateAgent("shipped", 4);
    const waiting = addWorktree("waiting");
    idle(waiting, 5);
    writeAgent(agent("waiting", { dir: waiting, worktreePath: waiting, prMonitor: merged(1) }));
    backdateAgent("waiting", 4);

    const plan = planGc(POLICY);
    expect(plan.agents.map((a) => a.name)).toEqual(["shipped"]);
    expect(plan.worktrees.map((w) => w.path)).toEqual([wt]);
    applyGc(plan, POLICY);
    expect(readAgent("shipped")).toBeNull();
    expect(readTrashedState("shipped")).not.toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(waiting)).toBe(true);
  });

  test("an open or closed pull request does not shorten anything", () => {
    const wt = addWorktree("open");
    idle(wt, 5);
    const prs = merged(10);
    prs.pullRequests.push({ ...prs.pullRequests[0]!, number: 2, url: "https://github.com/o/r/pull/2", state: "OPEN" as never });
    writeAgent(agent("open", { dir: wt, worktreePath: wt, prMonitor: prs }));
    backdateAgent("open", 4);
    const plan = planGc(POLICY);
    expect(plan.agents).toEqual([]);
    expect(plan.worktrees).toEqual([]);
  });

  test("a registered agent's worktree is never collected, however old", () => {
    const wt = addWorktree("resumable");
    idle(wt, 400);
    writeAgent(agent("resumable", { dir: wt, worktreePath: wt }));
    const plan = planGc({ ...POLICY, agentDays: 1000 });
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees).toEqual([]);
    expect(plan.ownedWorktrees).toBe(1);
  });
});

describe("unowned worktrees", () => {
  test("recent activity, a keep marker, and a marked parent each keep one", () => {
    const fresh = addWorktree("fresh");
    const marked = addWorktree("marked");
    writeFileSync(join(marked, KEEP_MARKER), "");
    idle(marked, 10);
    const gone = addWorktree("gone");
    idle(gone, 10);

    const plan = planGc(POLICY);
    expect(plan.worktrees.map((w) => w.path)).toEqual([gone]);
    const kept = new Map(plan.keptWorktrees.map((w) => [w.path, w.kind]));
    expect(kept.get(fresh)).toBe("recent");
    expect(kept.get(marked)).toBe("marker");

    // The marker also wins at apply time, when it appears after planning.
    writeFileSync(join(gone, KEEP_MARKER), "");
    idle(gone, 10);
    expect(applyGc(plan, POLICY).join("\n")).toContain("keep marker");
    expect(existsSync(gone)).toBe(true);
  });

  test("commits no remote has are kept until pushed", () => {
    const wt = addWorktree("local-only");
    commit(wt);
    idle(wt, 10);
    let plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees.map((w) => w.kind)).toEqual(["unpushed"]);

    git(wt, "push", "-q", "origin", "am/local-only");
    idle(wt, 10);
    plan = planGc(POLICY);
    expect(plan.worktrees.map((w) => w.path)).toEqual([wt]);
  });

  test("a merged pull request's head proves a deleted remote branch was pushed", () => {
    const wt = addWorktree("squashed");
    const head = commit(wt);
    idle(wt, 10);
    trash(agent("squashed", { dir: wt, worktreePath: wt, worktreeBranch: "am/squashed", repoRoot: repo, prMonitor: merged(5) }), 1);

    // Unknown head: still unpushed as far as gc can tell.
    expect(planGc({ ...POLICY, prHead: () => null }).worktrees).toEqual([]);
    // A different head with HEAD not behind it: commits made after the merge.
    expect(planGc({ ...POLICY, prHead: () => git(repo, "rev-parse", "main") }).worktrees).toEqual([]);
    const policy = { ...POLICY, prHead: () => head };
    const plan = planGc(policy);
    expect(plan.worktrees.map((w) => w.path)).toEqual([wt]);
    applyGc(plan, policy);
    expect(existsSync(wt)).toBe(false);
  });

  test("subagent worktrees nested in an agent's worktree are collected on their own", () => {
    const parent = addWorktree("parent");
    writeAgent(agent("parent", { dir: parent, worktreePath: parent, status: "idle" }));
    const stale = addWorktree("sub-stale", join(parent, ".claude", "worktrees", "agent-stale"));
    idle(stale, 10);
    const active = addWorktree("sub-active", join(parent, ".claude", "worktrees", "agent-active"));
    const dirty = addWorktree("sub-dirty", join(parent, ".claude", "worktrees", "agent-dirty"));
    writeFileSync(join(dirty, "wip.txt"), "wip\n");
    idle(dirty, 10, "wip.txt");

    const plan = planGc(POLICY);
    expect(plan.worktrees.map((w) => w.path)).toEqual([stale]);
    const kept = new Map(plan.keptWorktrees.map((w) => [w.path, w.kind]));
    expect(kept.get(active)).toBe("recent");
    expect(kept.get(dirty)).toBe("dirty");
    applyGc(plan, POLICY);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(parent)).toBe(true);

    // A keep marker on the parent covers the nested ones.
    writeFileSync(join(parent, KEEP_MARKER), "");
    idle(active, 10);
    expect(planGc(POLICY).worktrees).toEqual([]);
  });
});

describe("stale dirty worktrees", () => {
  test("changes untouched past staleDays are saved to a ref, the worktree removed, and restore puts them back", () => {
    const wt = addWorktree("abandoned");
    writeFileSync(join(wt, "tracked.txt"), "v1\n");
    git(wt, "add", "tracked.txt");
    git(wt, "commit", "-q", "-m", "tracked");
    writeFileSync(join(wt, "tracked.txt"), "v2 uncommitted\n");
    mkdirSync(join(wt, "notes"));
    writeFileSync(join(wt, "notes", "idea.md"), "untracked\n");
    idle(wt, 40, "tracked.txt", "notes", join("notes", "idea.md"));

    const plan = planGc(POLICY);
    expect(plan.worktrees).toHaveLength(1);
    expect(plan.worktrees[0]!.salvage).toContain("untouched for 40d");
    const lines = applyGc(plan, POLICY);
    expect(lines.join("\n")).toContain("refs/am-gc/abandoned-");
    expect(existsSync(wt)).toBe(false);

    const entry = readGcLog().find((e) => e.action === "remove-worktree")!;
    expect(entry.branch).toBe("am/abandoned");
    expect(entry.salvageRef).toStartWith("refs/am-gc/abandoned-");
    expect(git(repo, "show", `${entry.salvageRef}:notes/idea.md`)).toBe("untracked");

    restoreWorktree("abandoned");
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("v2 uncommitted\n");
    expect(readFileSync(join(wt, "notes", "idea.md"), "utf8")).toBe("untracked\n");
    expect(git(wt, "status", "--porcelain")).toContain("tracked.txt");
    expect(git(wt, "symbolic-ref", "--short", "HEAD")).toBe("am/abandoned");
  });

  test("am restore of an agent whose worktree gc salvaged says how to put the changes back", async () => {
    const wt = addWorktree("salvaged");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    idle(wt, 40, "wip.txt");
    trash(agent("salvaged", { dir: wt, worktreePath: wt, worktreeBranch: "am/salvaged", repoRoot: repo }), 8);
    applyGc(planGc(POLICY), POLICY);
    expect(existsSync(wt)).toBe(false);
    const ref = readGcLog().find((e) => e.action === "remove-worktree")!.salvageRef!;

    const out: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
    try { await restoreCommand("salvaged", { resume: false }); }
    finally { console.log = log; }
    expect(out.join("\n")).toContain(`git -C ${wt} restore --source=${ref} --worktree -- .`);
    git(wt, "restore", `--source=${ref}`, "--worktree", "--", ".");
    expect(readFileSync(join(wt, "wip.txt"), "utf8")).toBe("wip\n");
  });

  test("a recently edited file keeps the worktree, as does staleDays 0", () => {
    const wt = addWorktree("in-progress");
    writeFileSync(join(wt, "old.txt"), "old\n");
    writeFileSync(join(wt, "new.txt"), "new\n");
    idle(wt, 40, "old.txt");
    expect(planGc(POLICY).worktrees).toEqual([]);

    idle(wt, 40, "old.txt", "new.txt");
    expect(planGc({ ...POLICY, staleDays: 0 }).worktrees).toEqual([]);
    expect(planGc(POLICY).worktrees).toHaveLength(1);
  });

  test("a file edited after planning cancels the removal", () => {
    const wt = addWorktree("revived");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    idle(wt, 40, "wip.txt");
    const plan = planGc(POLICY);
    expect(plan.worktrees).toHaveLength(1);
    writeFileSync(join(wt, "wip.txt"), "back at it\n");
    applyGc(plan, POLICY);
    expect(existsSync(wt)).toBe(true);
  });

  test("stale unpushed commits are pinned by the ref and the branch", () => {
    const wt = addWorktree("unpushed");
    const head = commit(wt);
    idle(wt, 40);
    const plan = planGc(POLICY);
    expect(plan.worktrees[0]!.salvage).toContain("unpushed commits");
    applyGc(plan, POLICY);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "rev-parse", "am/unpushed")).toBe(head);
    // Nothing uncommitted: HEAD is pinned, but there are no changes to put back.
    const entry = readGcLog().find((e) => e.action === "remove-worktree")!;
    expect(entry.salvageRef).toBeUndefined();
    expect(git(repo, "rev-parse", entry.pinRef!)).toBe(head);
  });

  test("a stale worktree still holding subagent worktrees is kept", () => {
    const wt = addWorktree("holder");
    const nested = addWorktree("inner", join(wt, ".claude", "worktrees", "agent-inner"));
    writeFileSync(join(nested, "wip.txt"), "wip\n");
    idle(wt, 40);
    idle(nested, 2, "wip.txt");
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees.find((w) => w.path === wt)!.reason).toContain("contains subagent worktrees");
  });

  test("only git-ignored leftovers go after ignoredDays — unless commits under them are unpushed", () => {
    writeFileSync(join(repo, ".gitignore"), ".env.local\nnode_modules/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore");
    git(repo, "push", "-q", "origin", "main");
    const policy = { ...POLICY, ignoredDays: 7 };
    const leftovers = (name: string, days: number) => {
      const wt = addWorktree(name);
      writeFileSync(join(wt, ".env.local"), "SECRET=1\n");
      mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
      idle(wt, days, ".env.local", "node_modules");
      return wt;
    };
    const old = leftovers("env-old", 9);
    const young = leftovers("env-young", 5);
    const unpushed = leftovers("env-unpushed", 9);
    commit(unpushed);
    idle(unpushed, 9, ".env.local", "node_modules");
    const mixed = leftovers("env-mixed", 9);
    writeFileSync(join(mixed, "wip.txt"), "wip\n");
    idle(mixed, 9, ".env.local", "node_modules", "wip.txt");

    const plan = planGc(policy);
    expect(plan.worktrees.map((w) => [w.path, w.salvage])).toEqual([[old, "only git-ignored files, untouched for 9d"]]);
    const kept = new Map(plan.keptWorktrees.map((w) => [w.path, w.reason]));
    expect(kept.get(young)).toBe("only git-ignored files");
    expect(kept.get(unpushed)).toBe("unpushed commits");
    expect(kept.get(mixed)).toBe("uncommitted or ignored files");
    applyGc(plan, policy);
    expect(existsSync(old)).toBe(false);
    // Without the shorter age they wait as long as any other change.
    expect(planGc(POLICY).worktrees).toEqual([]);
  });

  test("a file rewritten inside an old ignored directory counts as a recent change", () => {
    writeFileSync(join(repo, ".gitignore"), "tmp/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore");
    git(repo, "push", "-q", "origin", "main");
    const policy = { ...POLICY, ignoredDays: 7 };
    const wt = addWorktree("ignored-edit");
    mkdirSync(join(wt, "tmp", "db"), { recursive: true });
    writeFileSync(join(wt, "tmp", "db", "local.sqlite3"), "data");
    touch(join(wt, "tmp", "db", "local.sqlite3"), 2);
    idle(wt, 9, join("tmp", "db"), "tmp");
    const plan = planGc(policy);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees.find((w) => w.path === wt)!.reason).toBe("only git-ignored files");
    touch(join(wt, "tmp", "db", "local.sqlite3"), 9);
    idle(wt, 9, join("tmp", "db"), "tmp");
    expect(planGc({ ...policy, staleDays: 8 }).worktrees.map((w) => w.path)).toEqual([wt]);
  });

  test("a nested repository in an ignored or untracked path keeps the worktree, at plan and at removal", () => {
    writeFileSync(join(repo, ".gitignore"), "tmp/\nnode_modules/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore");
    git(repo, "push", "-q", "origin", "main");
    const policy = { ...POLICY, ignoredDays: 7 };
    const clone = addWorktree("with-clone");
    mkdirSync(join(clone, "tmp"));
    git(join(clone, "tmp"), "clone", "-q", origin, "other-repo");
    idle(clone, 9, "tmp");
    const linked = addWorktree("with-linked");
    addWorktree("inner-linked", join(linked, "work", "inner"));
    idle(linked, 40, "work");

    const plan = planGc(policy);
    expect(plan.worktrees).toEqual([]);
    const kept = new Map(plan.keptWorktrees.map((w) => [w.path, w.reason]));
    expect(kept.get(clone)).toBe("only git-ignored files; contains a nested git repository");
    expect(kept.get(linked)).toBe("uncommitted or ignored files; contains a nested git repository");

    // A repository that appears after planning is caught under the deletion lock.
    const late = addWorktree("late-clone");
    mkdirSync(join(late, "tmp"));
    writeFileSync(join(late, "tmp", "x"), "x");
    idle(late, 9, join("tmp", "x"), "tmp");
    const latePlan = planGc(policy);
    expect(latePlan.worktrees.map((w) => w.path)).toEqual([late]);
    git(join(late, "tmp"), "clone", "-q", origin, "other-repo");
    idle(late, 9, "tmp");
    expect(applyGc(latePlan, policy).join("\n")).toContain("contains a nested git repository");
    expect(existsSync(join(late, "tmp", "other-repo", ".git"))).toBe(true);
  });

  test("an initialized submodule keeps even a clean worktree", () => {
    const lib = join(home, "lib");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", lib]);
    git(lib, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "lib");
    const wt = addWorktree("with-submodule");
    git(wt, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
    git(wt, "commit", "-q", "-m", "add lib");
    git(wt, "push", "-q", "origin", "am/with-submodule");
    idle(wt, 10);
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees[0]!.reason).toBe("contains a nested git repository (submodule)");
  });

  test("an agent that still owns it keeps even a long-stale dirty worktree", () => {
    const wt = addWorktree("owned-dirty");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    idle(wt, 400, "wip.txt");
    writeAgent(agent("owned-dirty", { dir: wt, worktreePath: wt }));
    expect(planGc({ ...POLICY, agentDays: 1000 }).worktrees).toEqual([]);
  });
});

describe("old files", () => {
  test("handoff transcripts and cached artifacts age out; plans and recent files stay", () => {
    const handoffs = join(home, "handoffs");
    const cache = join(home, "artifacts-cache", "laptop", "agent");
    mkdirSync(handoffs, { recursive: true });
    mkdirSync(cache, { recursive: true });
    mkdirSync(join(home, "plans"), { recursive: true });
    const oldHandoff = join(handoffs, "a-to-claude-old.md");
    const newHandoff = join(handoffs, "a-to-claude-new.md");
    const cached = join(cache, "report.html");
    const plan = join(home, "plans", "a.md");
    for (const file of [oldHandoff, newHandoff, cached, plan]) writeFileSync(file, "x");
    for (const file of [oldHandoff, cached, plan]) touch(file, 45);

    const gcPlan = planGc(POLICY);
    expect(gcPlan.orphans.map((o) => [o.kind, o.path]).sort()).toEqual([["cache", cached], ["handoff", oldHandoff]]);
    applyGc(gcPlan, POLICY);
    expect(existsSync(oldHandoff)).toBe(false);
    expect(existsSync(newHandoff)).toBe(true);
    expect(existsSync(plan)).toBe(true);
    // Without fileDays (the library default) nothing ages out.
    writeFileSync(oldHandoff, "x");
    touch(oldHandoff, 45);
    expect(planGc({ agentDays: 7, trashDays: 30 }).orphans).toEqual([]);
  });
});

describe("hardening", () => {
  const empty: GcPlan = { agents: [], trash: [], orphans: [], worktrees: [], keptWorktrees: [], ownedWorktrees: 0, uninspectedWorktrees: 0, codexTrust: [], claudeTrust: [] };

  test("a symlinked .claude never leads gc to worktrees outside the managed dir", () => {
    const external = join(repo, ".claude", "worktrees", "my-session");
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "mine", external);
    writeFileSync(join(repo, ".git", "info", "exclude"), ".env.local\n.claude/\n");
    writeFileSync(join(external, ".env.local"), "SECRET=1\n");
    git(external, "push", "-q", "origin", "mine");
    idle(external, 10, ".env.local");
    const managed = addWorktree("agent-a");
    symlinkSync(join(repo, ".claude"), join(managed, ".claude"));
    writeAgent(agent("agent-a", { dir: managed, status: "idle" }));
    const policy = { ...POLICY, ignoredDays: 7 };

    const plan = planGc(policy);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees.map((w) => w.path)).not.toContain(external);
    // A removal that names it anyway — a stale plan, a swapped path — is refused under the lock too.
    const lines = applyGc({ ...empty, worktrees: [{ path: join(managed, ".claude", "worktrees", "my-session"), repoRoot: repo, salvage: "x" }] }, policy);
    expect(lines.join("\n")).toContain("path leaves the managed worktrees directory");
    expect(readFileSync(join(external, ".env.local"), "utf8")).toBe("SECRET=1\n");
  });

  test("small ignored files are saved with the changes and put back; large ones and build output are reported", () => {
    writeFileSync(join(repo, ".gitignore"), ".env.local\ntmp/\nbig.bin\nnode_modules/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-q", "-m", "ignore");
    git(repo, "push", "-q", "origin", "main");
    const wt = addWorktree("leftovers");
    writeFileSync(join(wt, ".env.local"), "SECRET=1\n");
    mkdirSync(join(wt, "tmp"));
    writeFileSync(join(wt, "tmp", "notes.md"), "notes\n");
    writeFileSync(join(wt, "big.bin"), Buffer.alloc((1 << 20) + 1));
    mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "pkg", "index.js"), "x");
    idle(wt, 9, ".env.local", join("tmp", "notes.md"), "tmp", "big.bin", join("node_modules", "pkg", "index.js"), join("node_modules", "pkg"), "node_modules");
    const policy = { ...POLICY, ignoredDays: 7 };
    const lines = applyGc(planGc(policy), policy);
    expect(existsSync(wt)).toBe(false);
    expect(lines.join("\n")).toContain("not saved: 2 ignored entries");
    const entry = readGcLog().find((e) => e.action === "remove-worktree")!;
    expect(entry.savedIgnored).toBe(2);
    expect(entry.dropped).toBe(2);
    expect(entry.droppedPaths!.sort()).toEqual(["big.bin", "node_modules/"]);

    const restored = restoreWorktree("leftovers");
    expect(restored.join("\n")).toContain("its uncommitted changes and 2 ignored files");
    expect(restored.join("\n")).toContain("gc did not save 2 ignored entries");
    expect(readFileSync(join(wt, ".env.local"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(wt, "tmp", "notes.md"), "utf8")).toBe("notes\n");
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  test("local edits to skip-worktree and assume-unchanged files make a worktree dirty, and are salvaged", () => {
    writeFileSync(join(repo, "config.yml"), "db: prod\n");
    writeFileSync(join(repo, "sparse.txt"), "sparse\n");
    git(repo, "add", "config.yml", "sparse.txt");
    git(repo, "commit", "-q", "-m", "config");
    git(repo, "push", "-q", "origin", "main");
    const wt = addWorktree("hidden-edits");
    git(wt, "push", "-q", "origin", "am/hidden-edits");
    // An absent skip-worktree file is a sparse checkout, not a change.
    git(wt, "update-index", "--skip-worktree", "sparse.txt");
    rmSync(join(wt, "sparse.txt"));
    git(wt, "update-index", "--skip-worktree", "config.yml");
    idle(wt, 10);
    expect(planGc(POLICY).worktrees.map((w) => w.path)).toEqual([wt]);

    writeFileSync(join(wt, "config.yml"), "db: local-only\n");
    idle(wt, 10, "config.yml");
    const plan = planGc(POLICY);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees[0]!.kind).toBe("dirty");

    idle(wt, 40, "config.yml");
    applyGc(planGc(POLICY), POLICY);
    expect(existsSync(wt)).toBe(false);
    const ref = readGcLog().find((e) => e.action === "remove-worktree")!.salvageRef!;
    expect(git(repo, "show", `${ref}:config.yml`)).toBe("db: local-only");
  });

  test("salvage refs are unique and never overwrite one another", () => {
    const wt = addWorktree("twice");
    writeFileSync(join(wt, "a.txt"), "a\n");
    const first = salvageWorktree(wt, "same");
    writeFileSync(join(wt, "a.txt"), "b\n");
    const second = salvageWorktree(wt, "same");
    expect(first.ref).not.toBe(second.ref);
    expect(git(repo, "show", `${first.ref}:a.txt`)).toBe("a");
    expect(git(repo, "show", `${second.ref}:a.txt`)).toBe("b");
  });
});

describe("applying", () => {
  test("a file that cannot be removed is reported and the rest of the run goes on", () => {
    const stuck = join(home, "inbox", "gone-a");
    const fine = join(home, "inbox", "gone-b");
    for (const dir of [stuck, fine]) {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "f"), "x");
      touch(dir, 2);
    }
    const wt = addWorktree("after-orphans");
    idle(wt, 10);
    const plan = planGc(POLICY);
    expect(plan.orphans.map((o) => o.path).sort()).toEqual([stuck, fine]);
    chmodSync(join(stuck, "sub"), 0o500);
    try {
      const lines = applyGc(plan, POLICY);
      expect(lines.join("\n")).toContain(`warning: could not remove inbox ${stuck}`);
      expect(existsSync(fine)).toBe(false);
      expect(existsSync(wt)).toBe(false);
    } finally {
      chmodSync(join(stuck, "sub"), 0o700);
    }
  });
});

describe("inspection cost", () => {
  test("a kept worktree is not inspected again until something about it changes", () => {
    const wt = addWorktree("parked");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    idle(wt, 10);
    expect(planGc(POLICY).keptWorktrees[0]!.reason).toBe("uncommitted or ignored files");
    // Cleaned up without any activity gc can see for free: the old verdict stands for now.
    const { atime, mtime } = statSync(wt);
    rmSync(join(wt, "wip.txt"));
    utimesSync(wt, atime, mtime);
    const again = planGc(POLICY);
    expect(again.worktrees).toEqual([]);
    expect(again.keptWorktrees[0]!.reason).toBe("uncommitted or ignored files (checked today)");
    // A commit is activity: it is looked at afresh (and is then recent).
    commit(wt);
    expect(planGc(POLICY).keptWorktrees[0]!.kind).toBe("recent");
    git(wt, "push", "-q", "origin", "am/parked");
    idle(wt, 10);
    expect(planGc(POLICY).worktrees.map((w) => w.path)).toEqual([wt]);
  });

  test("a push releases a worktree remembered as unpushed", () => {
    const wt = addWorktree("late-push");
    commit(wt);
    idle(wt, 10);
    expect(planGc(POLICY).keptWorktrees[0]!.kind).toBe("unpushed");
    expect(planGc(POLICY).keptWorktrees[0]!.reason).toContain("checked today");
    git(wt, "push", "-q", "origin", "am/late-push");
    expect(planGc(POLICY).worktrees.map((w) => w.path)).toEqual([wt]);
  });

  test("a plan stops inspecting at its time budget and says how many are left", () => {
    for (const name of ["a", "b"]) idle(addWorktree(name), 10);
    const plan = planGc({ ...POLICY, budgetMs: -1 });
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees).toEqual([]);
    expect(plan.uninspectedWorktrees).toBe(2);
    expect(planGc(POLICY).worktrees).toHaveLength(2);
  });
});

describe("gcPolicy", () => {
  test("config defaults; a garbage age never reads as collect-now", () => {
    expect(gcPolicy(loadConfig())).toMatchObject({ agentDays: 7, trashDays: 30, mergedDays: 3, removedDays: 7, orphanDays: 3, staleDays: 30, ignoredDays: 7, fileDays: 30 });
    const odd = gcPolicy({ ...loadConfig(), gcStaleDays: "soon" as never, gcOrphanDays: -1, gcRemovedDays: null as never }, { agentDays: 2 });
    expect(odd).toMatchObject({ agentDays: 2, staleDays: 0, orphanDays: 3, removedDays: 7 });
    // A number written as a string means that number, not a shorter default.
    expect(gcPolicy({ ...loadConfig(), gcRemovedDays: "30" as never, gcStaleDays: " " as never })).toMatchObject({ removedDays: 30, staleDays: 0 });
  });
});
