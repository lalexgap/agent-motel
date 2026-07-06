import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGc, planGc, queueEntryOwner } from "../src/gc";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { readTrashedState, trashState } from "../src/trash";
import { queueAppend, queueDepth } from "../src/queue";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-gc-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

const DAY = 86_400_000;

function makeAgent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return {
    name,
    status: "exited",
    dir: home,
    // No such tmux session — the agent reads as dead/exited.
    tmuxSession: `agentmgr-gc-test-${name}`,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

// writeAgent stamps updatedAt = now, so backdate by rewriting the file.
function backdateAgent(name: string, days: number): void {
  const agent = readAgent(name)!;
  writeFileSync(
    join(home, "agents", `${name}.json`),
    JSON.stringify({ ...agent, updatedAt: daysAgo(days) }, null, 2) + "\n",
  );
}

function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

describe("planGc agents", () => {
  test("reaps only session-less agents past the retention", () => {
    writeAgent(makeAgent("old"));
    backdateAgent("old", 10);
    writeAgent(makeAgent("recent"));

    const plan = planGc({ agentDays: 7, trashDays: 30 });
    expect(plan.agents.map((a) => a.name)).toEqual(["old"]);
  });

  test("applyGc reaps into trash, restorable", () => {
    writeAgent(makeAgent("old"));
    backdateAgent("old", 10);

    const lines = applyGc(planGc({ agentDays: 7, trashDays: 30 }));
    expect(lines.join("\n")).toContain('reaped agent "old"');
    expect(readAgent("old")).toBeNull();
    expect(readTrashedState("old")?.name).toBe("old");
  });
});

describe("planGc trash", () => {
  test("purges only snapshots past the retention", () => {
    trashState(makeAgent("fresh"));
    trashState(makeAgent("stale"));
    const staleFile = join(home, "trash", "stale.json");
    writeFileSync(
      staleFile,
      JSON.stringify({ ...makeAgent("stale"), trashedAt: daysAgo(45) }, null, 2) + "\n",
    );

    const plan = planGc({ agentDays: 7, trashDays: 30 });
    expect(plan.trash.map((t) => t.name)).toEqual(["stale"]);

    applyGc(plan);
    expect(existsSync(staleFile)).toBe(false);
    expect(readTrashedState("fresh")?.name).toBe("fresh");
  });
});

describe("planGc orphans", () => {
  test("flags queue/snapshot/inbox leavings of unknown agents, keeps live ones", () => {
    writeAgent(makeAgent("alive"));
    queueAppend("alive", "pending");
    queueAppend("ghost", "orphaned");
    mkdirSync(join(home, "snapshots"), { recursive: true });
    writeFileSync(join(home, "snapshots", "ghost.txt"), "last screen\n");
    mkdirSync(join(home, "inbox", "ghost"), { recursive: true });

    const plan = planGc({ agentDays: 7, trashDays: 30 });
    const paths = plan.orphans.map((o) => o.path).sort();
    expect(paths).toEqual([
      join(home, "inbox", "ghost"),
      join(home, "queue", "ghost"),
      join(home, "snapshots", "ghost.txt"),
    ]);

    applyGc(plan);
    expect(queueDepth("alive")).toBe(1);
    expect(existsSync(join(home, "queue", "ghost"))).toBe(false);
  });

  test("keeps the inbox of a trashed (restorable) agent", () => {
    trashState(makeAgent("resting"));
    mkdirSync(join(home, "inbox", "resting"), { recursive: true });

    const plan = planGc({ agentDays: 7, trashDays: 30 });
    expect(plan.orphans).toEqual([]);
  });

  test("queueEntryOwner maps dirs, legacy files, and locks to their agent", () => {
    expect(queueEntryOwner("api", true)).toBe("api");
    expect(queueEntryOwner("api.jsonl", false)).toBe("api");
    expect(queueEntryOwner("api.jsonl.migrating.123", false)).toBe("api");
    expect(queueEntryOwner("api.deliver.lock", false)).toBe("api");
    expect(queueEntryOwner("stray.txt", false)).toBeNull();
  });
});

describe("planGc worktrees", () => {
  let repo: string;

  function makeRepo(): void {
    repo = join(home, "repo");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
    git(repo, "config", "user.email", "t@t.t");
    git(repo, "config", "user.name", "t");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  }

  function addWorktree(name: string): string {
    const path = join(home, "worktrees", "repo", name);
    mkdirSync(join(home, "worktrees", "repo"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", `am/${name}`, path);
    return path;
  }

  test("removes a clean unreferenced worktree, keeps dirty and referenced ones", () => {
    makeRepo();
    const clean = addWorktree("clean");
    const dirty = addWorktree("dirty");
    writeFileSync(join(dirty, "uncommitted.txt"), "wip\n");
    const referenced = addWorktree("referenced");
    writeAgent(makeAgent("keeper", { dir: referenced, worktreePath: referenced, status: "idle" }));

    const plan = planGc({ agentDays: 7, trashDays: 30 });
    const byPath = new Map(plan.worktrees.map((w) => [w.path, w]));
    expect(byPath.get(clean)?.action).toBe("remove");
    expect(byPath.get(dirty)?.action).toBe("keep");
    expect(byPath.get(dirty)?.reason).toContain("uncommitted");
    expect(byPath.has(referenced)).toBe(false);

    applyGc(plan);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    // The removed worktree's branch survives in the repo.
    const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", "am/clean"]).stdout.toString();
    expect(branches).toContain("am/clean");
  });

  test("a worktree referenced by an agent being reaped in the same run is collectable", () => {
    makeRepo();
    const wt = addWorktree("stale");
    writeAgent(makeAgent("stale", { dir: wt, worktreePath: wt }));
    backdateAgent("stale", 10);

    const plan = planGc({ agentDays: 7, trashDays: 30 });
    expect(plan.agents.map((a) => a.name)).toEqual(["stale"]);
    expect(plan.worktrees.find((w) => w.path === wt)?.action).toBe("remove");
  });
});
