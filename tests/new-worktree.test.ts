import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/commands/new";

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function initRepo(path: string): void {
  Bun.spawnSync(["git", "init", "-q", "-b", "main", path]);
  git(path, "config", "user.email", "t@t.t");
  git(path, "config", "user.name", "t");
}

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "am-newwt-"));
  process.env.AGENTMGR_HOME = join(root, "am-home");
  repo = join(root, "repo");
  initRepo(repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("createWorktree", () => {
  test("branches from freshly fetched origin default branch, not the checkout's HEAD", async () => {
    const origin = join(root, "origin.git");
    Bun.spawnSync(["git", "clone", "-q", "--bare", repo, origin]);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "fetch", "-q", "origin");
    git(repo, "remote", "set-head", "origin", "main");

    // Someone else lands a commit on origin/main that the local repo hasn't fetched.
    const other = join(root, "other");
    Bun.spawnSync(["git", "clone", "-q", origin, other]);
    git(other, "config", "user.email", "t@t.t");
    git(other, "config", "user.name", "t");
    git(other, "commit", "-q", "--allow-empty", "-m", "upstream");
    git(other, "push", "-q", "origin", "main");
    const upstream = git(other, "rev-parse", "HEAD");

    // The main checkout sits on an unrelated feature branch.
    git(repo, "checkout", "-q", "-b", "feature/x");
    git(repo, "commit", "-q", "--allow-empty", "-m", "wip");

    const wt = await createWorktree("a", "am/a", repo);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(upstream);
    // No upstream tracking to origin/main — a bare `git push` must not target main.
    expect(Bun.spawnSync(["git", "-C", wt.path, "rev-parse", "--abbrev-ref", "@{u}"]).exitCode).not.toBe(0);
  });

  test("falls back to HEAD when there's no origin", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const wt = await createWorktree("a", "am/a", repo);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(head);
  });

  test("uses the local origin ref when the fetch fails", async () => {
    git(repo, "remote", "add", "origin", join(root, "missing.git"));
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const originMain = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-b", "feature/x");
    git(repo, "commit", "-q", "--allow-empty", "-m", "wip");
    const warnings: string[] = [];
    const wt = await createWorktree("a", "am/a", repo, { warn: (m) => warnings.push(m) });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(originMain);
    expect(warnings.length).toBe(1);
  });

  test("falls through a dangling origin/HEAD to origin/main", async () => {
    git(repo, "remote", "add", "origin", join(root, "missing.git"));
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
    const originMain = git(repo, "rev-parse", "HEAD");
    git(repo, "commit", "-q", "--allow-empty", "-m", "local");
    const wt = await createWorktree("a", "am/a", repo, { warn: () => {} });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(originMain);
  });

  test("--base overrides the default start point", async () => {
    git(repo, "remote", "add", "origin", join(root, "missing.git"));
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "commit", "-q", "--allow-empty", "-m", "local");
    const head = git(repo, "rev-parse", "HEAD");
    const wt = await createWorktree("a", "am/a", repo, { base: "HEAD" });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(head);
  });

  test("--base HEAD resolves in the caller's worktree", async () => {
    const callerWt = join(root, "caller");
    git(repo, "worktree", "add", "-q", "-b", "feature/y", callerWt);
    git(callerWt, "commit", "-q", "--allow-empty", "-m", "caller wip");
    const callerHead = git(callerWt, "rev-parse", "HEAD");
    const wt = await createWorktree("a", "am/a", callerWt, { base: "HEAD" });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(callerHead);
  });

  test("--base on an existing branch is an error", async () => {
    git(repo, "branch", "am/a");
    await expect(createWorktree("a", "am/a", repo, { base: "HEAD" })).rejects.toThrow(/already exists/);
  });

  test("checks out an existing branch as-is", async () => {
    git(repo, "branch", "am/a");
    const tip = git(repo, "rev-parse", "am/a");
    git(repo, "commit", "-q", "--allow-empty", "-m", "later");
    const wt = await createWorktree("a", "am/a", repo);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(tip);
  });
});
