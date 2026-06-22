import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferWorktree, withWorktreeMeta } from "../src/commands/move";
import type { AgentState } from "../src/state";

function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
}

let root: string;
let repo: string;
let worktree: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "am-wt-"));
  // Isolate logicalRepoRoot's listAgents() lookup from the real fleet.
  process.env.AGENTMGR_HOME = join(root, "am-home");
  repo = join(root, "repo");
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  worktree = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "feature/x", worktree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function agent(extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return { name: "a", status: "idle", dir: repo, tmuxSession: "agentmgr-a", createdAt: now, updatedAt: now, ...extra };
}

describe("inferWorktree", () => {
  test("recovers repoRoot + branch from a linked worktree", () => {
    const got = inferWorktree(worktree);
    expect(got).not.toBeNull();
    expect(got!.worktreePath).toBe(worktree);
    expect(got!.worktreeBranch).toBe("feature/x");
    expect(got!.repoRoot).toBe(repo);
  });

  test("returns null for the main checkout (nothing to recreate)", () => {
    expect(inferWorktree(repo)).toBeNull();
  });

  test("returns null for a non-git directory", () => {
    expect(inferWorktree(root)).toBeNull();
  });

  test("returns null for a missing directory", () => {
    expect(inferWorktree(join(root, "gone"))).toBeNull();
  });

  test("leaves branch undefined for a detached worktree", () => {
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    const detached = join(root, "det");
    git(repo, "worktree", "add", "-q", "--detach", detached, head);
    const got = inferWorktree(detached);
    expect(got).not.toBeNull();
    expect(got!.worktreeBranch).toBeUndefined();
    expect(got!.repoRoot).toBe(repo);
  });
});

describe("withWorktreeMeta", () => {
  test("backfills a worktree agent that never recorded its metadata", () => {
    const got = withWorktreeMeta(agent({ dir: worktree }));
    expect(got.worktreePath).toBe(worktree);
    expect(got.worktreeBranch).toBe("feature/x");
    expect(got.repoRoot).toBe(repo);
  });

  test("leaves an already-tagged worktree agent untouched", () => {
    const tagged = agent({ dir: worktree, worktreePath: "/old", repoRoot: "/old/repo", worktreeBranch: "kept" });
    expect(withWorktreeMeta(tagged)).toEqual(tagged);
  });

  test("is a no-op for a plain (main-checkout) directory", () => {
    const plain = agent({ dir: repo });
    expect(withWorktreeMeta(plain)).toEqual(plain);
  });
});
