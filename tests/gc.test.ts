import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGc, planGc } from "../src/gc";
import { queueEntryOwner } from "../src/queue";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { readTrashedState, trashState } from "../src/trash";
import { queueAppend, queueDepth } from "../src/queue";
import { codexTrustLedgerFile, readCodexTrustLedger } from "../src/codexDaemon";

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

// Orphan collection has a freshness grace (a new file may belong to an agent
// mid-registration), so tests age the paths explicitly.
function backdateMtime(path: string, days: number): void {
  const t = (Date.now() - days * DAY) / 1000;
  utimesSync(path, t, t);
}

function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

const RETENTION = { agentDays: 7, trashDays: 30 };

describe("planGc agents", () => {
  test("reaps only session-less agents past the retention", () => {
    writeAgent(makeAgent("old"));
    backdateAgent("old", 10);
    writeAgent(makeAgent("recent"));

    const plan = planGc(RETENTION);
    expect(plan.agents.map((a) => a.name)).toEqual(["old"]);
  });

  test("a garbage updatedAt reads as infinitely old, not immortal", () => {
    writeAgent(makeAgent("broken"));
    const file = join(home, "agents", "broken.json");
    writeFileSync(file, JSON.stringify({ ...readAgent("broken")!, updatedAt: "not-a-date" }, null, 2) + "\n");

    const plan = planGc(RETENTION);
    expect(plan.agents.map((a) => a.name)).toEqual(["broken"]);
  });

  test("applyGc reaps into trash, restorable", () => {
    writeAgent(makeAgent("old"));
    backdateAgent("old", 10);

    const lines = applyGc(planGc(RETENTION));
    expect(lines.join("\n")).toContain('reaped agent "old"');
    expect(readAgent("old")).toBeNull();
    expect(readTrashedState("old")?.name).toBe("old");
  });

  test("an agent removed between plan and apply is skipped quietly", () => {
    writeAgent(makeAgent("old"));
    backdateAgent("old", 10);
    const plan = planGc(RETENTION);
    rmSync(join(home, "agents", "old.json"));

    const lines = applyGc(plan);
    expect(lines.join("\n")).not.toContain("reaped");
    expect(readTrashedState("old")).toBeNull();
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

    const plan = planGc(RETENTION);
    expect(plan.trash.map((t) => t.name)).toEqual(["stale"]);

    applyGc(plan);
    expect(existsSync(staleFile)).toBe(false);
    expect(readTrashedState("fresh")?.name).toBe("fresh");
  });

  test("purge runs before reap: a reaped agent's fresh snapshot survives a same-name purge", () => {
    // Old trash snapshot for "x" AND a dead agent "x" in the same run: the
    // purge must not delete the snapshot the reap just wrote.
    trashState(makeAgent("x"));
    writeFileSync(
      join(home, "trash", "x.json"),
      JSON.stringify({ ...makeAgent("x"), trashedAt: daysAgo(45) }, null, 2) + "\n",
    );
    writeAgent(makeAgent("x"));
    backdateAgent("x", 10);

    const plan = planGc(RETENTION);
    expect(plan.trash.map((t) => t.name)).toEqual(["x"]);
    expect(plan.agents.map((a) => a.name)).toEqual(["x"]);

    applyGc(plan);
    expect(readTrashedState("x")?.name).toBe("x"); // the fresh snapshot
    expect(readAgent("x")).toBeNull();
  });
});

describe("planGc orphans", () => {
  test("flags old queue/snapshot/inbox leavings of unknown agents, keeps live ones", () => {
    writeAgent(makeAgent("alive"));
    queueAppend("alive", "pending");
    queueAppend("ghost", "orphaned");
    mkdirSync(join(home, "snapshots"), { recursive: true });
    writeFileSync(join(home, "snapshots", "ghost.txt"), "last screen\n");
    mkdirSync(join(home, "inbox", "ghost"), { recursive: true });
    backdateMtime(join(home, "queue", "ghost"), 2);
    backdateMtime(join(home, "snapshots", "ghost.txt"), 2);
    backdateMtime(join(home, "inbox", "ghost"), 2);

    const plan = planGc(RETENTION);
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

  test("fresh strays are left alone — they may belong to an agent mid-registration", () => {
    queueAppend("just-spawning", "task");

    const plan = planGc(RETENTION);
    expect(plan.orphans).toEqual([]);
  });

  test("an orphan whose owner reappears before apply is spared", () => {
    queueAppend("ghost", "message");
    backdateMtime(join(home, "queue", "ghost"), 2);
    const plan = planGc(RETENTION);
    expect(plan.orphans.map((o) => o.owner)).toEqual(["ghost"]);

    writeAgent(makeAgent("ghost")); // re-registered between plan and apply
    applyGc(plan);
    expect(queueDepth("ghost")).toBe(1);
  });

  test("keeps the inbox of a trashed (restorable) agent", () => {
    trashState(makeAgent("resting"));
    mkdirSync(join(home, "inbox", "resting"), { recursive: true });
    backdateMtime(join(home, "inbox", "resting"), 2);

    const plan = planGc(RETENTION);
    expect(plan.orphans).toEqual([]);
  });

  test("shared artifacts follow the inbox rule; the operator bucket is never swept", () => {
    writeAgent(makeAgent("alive"));
    trashState(makeAgent("resting"));
    for (const name of ["alive", "resting", "ghost", "operator"]) {
      mkdirSync(join(home, "shared", name), { recursive: true });
      backdateMtime(join(home, "shared", name), 2);
    }

    const plan = planGc(RETENTION);
    expect(plan.orphans).toEqual([
      { kind: "shared", path: join(home, "shared", "ghost"), owner: "ghost" },
    ]);

    applyGc(plan);
    expect(existsSync(join(home, "shared", "ghost"))).toBe(false);
    expect(existsSync(join(home, "shared", "operator"))).toBe(true);
  });

  test("collects old unparseable trash snapshots (invisible to the normal purge)", () => {
    mkdirSync(join(home, "trash"), { recursive: true });
    const torn = join(home, "trash", "torn.json");
    writeFileSync(torn, "{not json");
    backdateMtime(torn, 45);

    const plan = planGc(RETENTION);
    expect(plan.orphans.map((o) => o.path)).toEqual([torn]);
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

    const plan = planGc(RETENTION);
    expect(plan.worktrees.map((w) => w.path)).toEqual([clean]);
    const kept = new Map(plan.keptWorktrees.map((w) => [w.path, w.reason]));
    expect(kept.get(dirty)).toContain("uncommitted");
    expect(kept.has(referenced)).toBe(false);

    applyGc(plan);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    // The removed worktree's branch survives in the repo.
    const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", "am/clean"]).stdout.toString();
    expect(branches).toContain("am/clean");
  });

  test("a restorable agent's worktree is protected — reaped this run or already trashed", () => {
    makeRepo();
    const reapedWt = addWorktree("stale");
    writeAgent(makeAgent("stale", { dir: reapedWt, worktreePath: reapedWt }));
    backdateAgent("stale", 10);
    const trashedWt = addWorktree("resting");
    trashState(makeAgent("resting", { dir: trashedWt, worktreePath: trashedWt }));

    const plan = planGc(RETENTION);
    expect(plan.agents.map((a) => a.name)).toEqual(["stale"]);
    // Neither worktree is collectable while its agent can still be restored.
    expect(plan.worktrees).toEqual([]);
  });

  test("a full clone parked under worktrees/ is never swept", () => {
    makeRepo();
    const cloneDir = join(home, "worktrees", "repo", "full-clone");
    mkdirSync(cloneDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", cloneDir]);

    const plan = planGc(RETENTION);
    expect(plan.worktrees).toEqual([]);
    expect(plan.keptWorktrees.map((w) => w.path)).toEqual([cloneDir]);
    expect(plan.keptWorktrees[0]!.reason).toContain("not a linked git worktree");
  });
});

describe("planGc codex trust", () => {
  test("prunes am-written trust entries whose dir is gone", () => {
    process.env.CODEX_HOME = home;
    try {
      writeFileSync(codexTrustLedgerFile(), JSON.stringify({ [home]: daysAgo(1), [join(home, "gone")]: daysAgo(1) }));
      const plan = planGc({ agentDays: 7, trashDays: 30 });
      expect(plan.codexTrust).toEqual([join(home, "gone")]);
      // No config entry left to remove, so apply needs no daemon.
      expect(applyGc(plan)).toContain(`removed codex trust entry for ${join(home, "gone")}`);
      expect(Object.keys(readCodexTrustLedger())).toEqual([home]);
    } finally {
      delete process.env.CODEX_HOME;
    }
  });
});
