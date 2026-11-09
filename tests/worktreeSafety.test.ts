import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planGc, applyGc } from "../src/gc";
import { destroyAgent } from "../src/commands/rm";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { trashState } from "../src/trash";
import { renameAgent } from "../src/commands/rename";
import { restoreCommand } from "../src/commands/restore";

let home: string, repo: string, wt: string;
let oldHome: string | undefined, oldPool: string | undefined;
const retention = { agentDays: 7, trashDays: 30 };
function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
function agent(name: string, dir = wt): AgentState {
  return { name, dir, status: "exited", tmuxSession: `am-safety-absent-${name}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
function pool(lease: unknown) {
  mkdirSync(join(home, "pool", "state"), { recursive: true });
  for (let i = 1; i <= 3; i++) writeFileSync(join(home, "pool", "state", `slot-${i}.json`), JSON.stringify({ lease: i === 1 ? lease : null }));
}
beforeEach(() => {
  oldHome = process.env.AGENTMGR_HOME;
  oldPool = process.env.DEV_POOL_ROOT;
  home = mkdtempSync(join(tmpdir(), "am-worktree-safety-"));
  process.env.AGENTMGR_HOME = home;
  process.env.DEV_POOL_ROOT = join(home, "pool");
  repo = join(home, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.test");
  git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
  wt = join(home, "worktrees", "repo", "checkout");
  git(repo, "worktree", "add", "-q", "-b", "fixture", wt);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTMGR_HOME; else process.env.AGENTMGR_HOME = oldHome;
  if (oldPool === undefined) delete process.env.DEV_POOL_ROOT; else process.env.DEV_POOL_ROOT = oldPool;
});

for (const trashed of [false, true]) test(`B05 protects ${trashed ? "restorable" : "registered"} symlink descendant`, () => {
  mkdirSync(join(wt, "frontend"));
  const alias = join(home, "alias");
  symlinkSync(wt, alias);
  const owner = agent("owner", join(alias, "frontend"));
  if (trashed) trashState(owner); else writeAgent(owner);
  expect(planGc(retention).worktrees).toEqual([]);
});

test("B06 rechecks a newly registered descendant owner before applying", () => {
  const plan = planGc(retention);
  expect(plan.worktrees).toHaveLength(1);
  mkdirSync(join(wt, "frontend"));
  writeAgent(agent("new-owner", join(wt, "frontend")));
  applyGc(plan);
  expect(existsSync(wt)).toBe(true);
});

test("B07 keeps detached commits without a durable reference", () => {
  git(wt, "checkout", "--detach", "-q");
  git(wt, "commit", "-q", "--allow-empty", "-m", "detached work");
  expect(planGc(retention).worktrees).toEqual([]);
  git(wt, "tag", "saved");
  expect(planGc(retention).worktrees).toHaveLength(1);
});

for (const mode of ["shared", "dirty", "restorable", "same-name-trash", "detached"] as const) test(`B08 rm clean preserves ${mode} checkout`, () => {
  const primary = { ...agent("primary"), worktreePath: wt, repoRoot: repo };
  writeAgent(primary);
  if (mode === "shared" || mode === "restorable" || mode === "same-name-trash") {
    mkdirSync(join(wt, "frontend"));
    const other = agent(mode === "same-name-trash" ? "primary" : "other", join(wt, "frontend"));
    other.createdAt = "2020-01-01T00:00:00.000Z";
    if (mode === "shared") writeAgent(other); else trashState(other);
  } else if (mode === "dirty") writeFileSync(join(wt, "valuable.txt"), "do not lose");
  else {
    git(wt, "checkout", "--detach", "-q");
    git(wt, "commit", "-q", "--allow-empty", "-m", "detached");
  }
  destroyAgent(primary, { clean: true });
  expect(existsSync(wt)).toBe(true);
});

for (const pinned of [false, true]) test(`B09 protects pool lease (pinned=${pinned}) at plan and apply`, () => {
  const plan = planGc(retention);
  pool({ worktree: wt, kind: pinned ? "preview" : "agent", pinned });
  expect(planGc(retention).worktrees).toEqual([]);
  applyGc(plan);
  expect(existsSync(wt)).toBe(true);
});

test("invalid lease data fails safe", () => {
  pool({ pinned: true });
  expect(planGc(retention).worktrees).toEqual([]);
});

for (const mode of ["gc", "rm"] as const) test(`dangling pool slot record preserves checkout during ${mode}`, () => {
  const plan = planGc(retention);
  mkdirSync(join(home, "pool", "state"), { recursive: true });
  symlinkSync(join(home, "missing-slot-record"), join(home, "pool", "state", "slot-1.json"));
  if (mode === "gc") {
    applyGc(plan);
    expect(planGc(retention).worktrees).toEqual([]);
  } else {
    const owner = { ...agent("dangling-slot"), worktreePath: wt, repoRoot: repo };
    writeAgent(owner);
    destroyAgent(owner, { clean: true });
  }
  expect(existsSync(wt)).toBe(true);
});

test("invalid agent ownership fails safe", () => {
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", "broken.json"), "{broken");
  expect(planGc(retention).worktrees).toEqual([]);
});

test("rm clean still removes an unshared clean checkout", () => {
  const primary = { ...agent("primary"), worktreePath: wt, repoRoot: repo };
  writeAgent(primary);
  destroyAgent(primary, { clean: true });
  expect(existsSync(wt)).toBe(false);
});

async function waitFor(file: string) {
  for (let n = 0; n < 300 && !existsSync(file); n++) await Bun.sleep(10);
  expect(existsSync(file)).toBe(true);
}
function worker(source: string) {
  return Bun.spawn([process.execPath, "-e", source], { cwd: import.meta.dir, env: { ...process.env, AGENTMGR_HOME: home, DEV_POOL_ROOT: join(home, "pool") }, stdout: "pipe", stderr: "pipe" });
}

test("registration wins the lock: GC observes the new owner", async () => {
  const plan = planGc(retention);
  const holding = join(home, "holding"), release = join(home, "release");
  const writer = worker(`
    import { writeAgent, updateAgentIf } from '../src/state';
    import { withWorktreeOwnershipLock } from '../src/worktreeOwnership';
    import { existsSync, writeFileSync } from 'node:fs';
    writeAgent(${JSON.stringify(agent("racer", home))});
    updateAgentIf('racer', state => {
      withWorktreeOwnershipLock(() => {
        writeFileSync(${JSON.stringify(holding)}, 'ready');
        while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
      });
      state.dir = ${JSON.stringify(wt)};
      return true;
    });
  `);
  try {
    await waitFor(holding);
    writeFileSync(release, "go");
    expect(await new Response(writer.stderr).text()).toBe("");
    expect(await writer.exited).toBe(0);
    expect(readAgent("racer")?.dir).toBe(wt);
    applyGc(plan);
    expect(existsSync(wt)).toBe(true);
  } finally { writer.kill(); }
});

test("removal wins the lock: a waiting registration cannot claim the deleted checkout", async () => {
  const holding = join(home, "holding"), release = join(home, "release"), started = join(home, "started");
  const remover = worker(`
    import { withWorktreeOwnershipLock } from '../src/worktreeOwnership';
    import { existsSync, writeFileSync } from 'node:fs';
    withWorktreeOwnershipLock(() => {
      writeFileSync(${JSON.stringify(holding)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
      const r = Bun.spawnSync(['git', '-C', ${JSON.stringify(repo)}, 'worktree', 'remove', ${JSON.stringify(wt)}]);
      if (r.exitCode) throw new Error(r.stderr.toString());
    });
  `);
  let writer: ReturnType<typeof worker> | undefined;
  try {
    await waitFor(holding);
    writer = worker(`
      import { writeAgent } from '../src/state';
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(started)}, 'ready');
      writeAgent(${JSON.stringify(agent("racer"))});
    `);
    await waitFor(started);
    await Bun.sleep(50);
    expect(writer.exitCode).toBeNull();
    writeFileSync(release, "go");
    expect(await remover.exited).toBe(0);
    expect(await writer.exited).not.toBe(0);
    expect(await new Response(writer.stderr).text()).toContain("missing worktree directory");
    expect(existsSync(join(home, "agents", "racer.json"))).toBe(false);
  } finally { remover.kill(); writer?.kill(); }
});

test("ownership lock releases after errors and status writes do not wait for it", async () => {
  const { withWorktreeOwnershipLock } = await import("../src/worktreeOwnership");
  writeAgent(agent("status-only"));
  expect(() => withWorktreeOwnershipLock(() => { throw new Error("fixture"); })).toThrow("fixture");
  const holding = join(home, "holding"), release = join(home, "release");
  const holder = worker(`
    import { withWorktreeOwnershipLock } from '../src/worktreeOwnership';
    import { existsSync, writeFileSync } from 'node:fs';
    withWorktreeOwnershipLock(() => {
      writeFileSync(${JSON.stringify(holding)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
    });
  `);
  try {
    await waitFor(holding);
    const status = worker(`import { setStatus, updateAgentIf } from '../src/state'; setStatus('status-only', 'idle'); updateAgentIf('status-only', s => { s.status = 'exited'; return true; });`);
    try {
      expect(await Promise.race([status.exited, Bun.sleep(1000).then(() => "blocked")])).toBe(0);
    } finally { status.kill(); }
    writeFileSync(release, "go");
    expect(await holder.exited).toBe(0);
  } finally { holder.kill(); }
});


test("rename preserves missing checkout metadata without claiming a new path", async () => {
  writeAgent({ ...agent("old"), worktreePath: wt, worktreeBranch: "fixture" });
  git(repo, "worktree", "remove", wt);
  await renameAgent("old", "renamed");
  expect(readAgent("old")).toBeNull();
  expect(readAgent("renamed")?.worktreePath).toBe(wt);
});

test("restore keeps transcript access when the checkout cannot be recreated", async () => {
  const state = { ...agent("recover"), worktreePath: wt, worktreeBranch: "missing", repoRoot: repo };
  trashState(state);
  git(repo, "worktree", "remove", wt);
  await restoreCommand("recover");
  expect(readAgent("recover")?.dir).toBe(wt);
  expect(readAgent("recover")?.status).toBe("exited");
  expect(existsSync(wt)).toBe(false);
});

for (const initialized of [false, true]) test(`unused lazily initialized pool slots allow cleanup (record=${initialized})`, () => {
  mkdirSync(join(home, "pool", "state"), { recursive: true });
  if (initialized) writeFileSync(join(home, "pool", "state", "slot-1.json"), JSON.stringify({ lease: null }));
  const plan = planGc(retention);
  expect(plan.worktrees).toHaveLength(1);
  applyGc(plan);
  expect(existsSync(wt)).toBe(false);
});

for (const ignored of [".env", "node_modules/package/index.js"]) test(`ignored ${ignored} protects checkout at apply and rm`, () => {
  writeFileSync(join(wt, ".gitignore"), ".env\nnode_modules/\n");
  git(wt, "add", ".gitignore");
  git(wt, "commit", "-qm", "ignore local data");
  const plan = planGc(retention);
  if (ignored.includes("/")) mkdirSync(join(wt, "node_modules", "package"), { recursive: true });
  writeFileSync(join(wt, ignored), "valuable local content");
  applyGc(plan);
  expect(existsSync(join(wt, ignored))).toBe(true);
  const owner = { ...agent("ignored"), worktreePath: wt, repoRoot: repo };
  writeAgent(owner);
  destroyAgent(owner, { clean: true });
  expect(existsSync(join(wt, ignored))).toBe(true);
});


test("fresh registration still refuses missing checkout metadata", () => {
  git(repo, "worktree", "remove", wt);
  expect(() => writeAgent({ ...agent("new"), worktreePath: wt })).toThrow("missing worktree directory");
  expect(readAgent("new")).toBeNull();
});

test("recovery cannot claim a different path or an obsolete incarnation", () => {
  const original = agent("recover");
  trashState(original);
  const next = { ...original, dir: join(home, "worktrees", "missing") };
  expect(() => writeAgent(next, { ownershipSource: { kind: "trash", owner: original } })).toThrow("ownership source changed");
  trashState({ ...original, createdAt: "2020-01-01T00:00:00.000Z" });
  expect(() => writeAgent(original, { ownershipSource: { kind: "trash", owner: original } })).toThrow("ownership source changed");
  expect(readAgent("recover")).toBeNull();
});


for (const removal of ["gc", "rm"]) test(`allocator lock blocks ${removal} before a lease is published`, () => {
  const plan = planGc(retention);
  const lock = join(home, "pool", "locks", "pool-allocate.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "allocator" }));
  if (removal === "gc") applyGc(plan);
  else {
    const owner = { ...agent("busy-pool"), worktreePath: wt, repoRoot: repo };
    writeAgent(owner);
    destroyAgent(owner, { clean: true });
  }
  expect(existsSync(wt)).toBe(true);
  expect(existsSync(lock)).toBe(true);
});


test("deletion lock releases after exceptions and preserves a replacement owner", async () => {
  const { withWorktreeDeletionLock } = await import("../src/worktreeOwnership");
  const lock = join(home, "pool", "locks", "pool-allocate.lock");
  expect(() => withWorktreeDeletionLock(() => { throw new Error("fixture"); })).toThrow("fixture");
  expect(existsSync(lock)).toBe(false);
  expect(withWorktreeDeletionLock(() => {
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "replacement" }));
  })).toBeNull();
  expect(existsSync(lock)).toBe(true);
});

test("deletion wins allocator exclusion: a later reservation rejects the missing checkout", async () => {
  const holding = join(home, "deleting"), release = join(home, "delete-go"), started = join(home, "allocating");
  const lock = join(home, "pool", "locks", "pool-allocate.lock");
  const remover = worker(`
    import { withWorktreeDeletionLock } from '../src/worktreeOwnership';
    import { existsSync, writeFileSync } from 'node:fs';
    const reason = withWorktreeDeletionLock(() => {
      writeFileSync(${JSON.stringify(holding)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(10);
      const result = Bun.spawnSync(['git', '-C', ${JSON.stringify(repo)}, 'worktree', 'remove', ${JSON.stringify(wt)}]);
      if (result.exitCode) throw new Error(result.stderr.toString());
    });
    if (reason) throw new Error(reason);
  `);
  let allocator: ReturnType<typeof worker> | undefined;
  try {
    await waitFor(holding);
    allocator = worker(`
      import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(started)}, 'ready');
      for (;;) {
        try { mkdirSync(${JSON.stringify(lock)}); break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; Bun.sleepSync(10); }
      }
      try {
        const result = Bun.spawnSync(['git', '-C', ${JSON.stringify(wt)}, 'rev-parse', '--show-toplevel']);
        if (result.exitCode) throw new Error('cannot lease missing worktree');
        writeFileSync(${JSON.stringify(join(home, 'unexpected-lease'))}, 'leased');
      } finally { rmSync(${JSON.stringify(lock)}, { recursive: true }); }
    `);
    await waitFor(started);
    await Bun.sleep(50);
    expect(allocator.exitCode).toBeNull();
    writeFileSync(release, "go");
    expect(await remover.exited).toBe(0);
    expect(await allocator.exited).not.toBe(0);
    expect(await new Response(allocator.stderr).text()).toContain("cannot lease missing worktree");
    expect(existsSync(join(home, "unexpected-lease"))).toBe(false);
    expect(existsSync(wt)).toBe(false);
  } finally { remover.kill(); allocator?.kill(); }
});
