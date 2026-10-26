import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cachedWorkspace, changedFiles, githubRepository, inspectWorkspace, inspectWorkspaceDiff } from "../src/workspace";

const dirs: string[] = [];
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "am-workspace-"));
  dirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.test");
  return dir;
}
function git(dir: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("GitHub remote parser never accepts credentials, other hosts or options", () => {
  for (const remote of ["git@github.com:owner/repo.git", "https://github.com/owner/repo", "ssh://git@github.com/owner/repo.git"])
    expect(githubRepository(remote)).toBe("owner/repo");
  for (const remote of ["https://evil.test/owner/repo", "https://github.com.evil.test/o/r", "https://secret@github.com/o/r", "--repo evil", "file:///a", "https://github.com/o/r?token=x"])
    expect(githubRepository(remote)).toBeNull();
});

test("NUL records preserve tabs, newlines and binary stats", () => {
  const files = changedFiles("M\0line\nwith\ttab\0", "-\t-\tline\nwith\ttab\0", "?? new\nfile\0");
  expect(files).toContainEqual({ path: "line\nwith\ttab", status: "M", working: false, additions: null, deletions: null });
  expect(files).toContainEqual({ path: "new\nfile", status: "??", working: true, additions: null, deletions: null });
});

test("includes committed branch changes, dirty edits, deletions and untracked files from a subdirectory", async () => {
  const dir = repo();
  writeFileSync(join(dir, "original.txt"), "original\n");
  writeFileSync(join(dir, "deleted.txt"), "delete\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "base");
  git(dir, "switch", "-c", "feature");
  writeFileSync(join(dir, "committed.txt"), "committed\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "feature");
  writeFileSync(join(dir, "original.txt"), "original\nmore\n");
  unlinkSync(join(dir, "deleted.txt"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "new.txt"), "new\n");
  const info = await inspectWorkspace(join(dir, "sub"));
  expect(info.error).toBeUndefined(); expect(info.base).toBe("main"); expect(info.branch).toBe("feature");
  expect(info.files.map(f => f.path)).toEqual(["committed.txt", "deleted.txt", "original.txt", "sub/new.txt"]);
  expect(info.files.find(f => f.path === "committed.txt")).toMatchObject({ status: "A", working: false, additions: 1 });
  expect(info.files.find(f => f.path === "original.txt")).toMatchObject({ working: true, additions: 1, deletions: 0 });
  expect(info.files.find(f => f.path === "deleted.txt")?.status).toBe("D");
});

test("new repositories report staged and untracked files without HEAD", async () => {
  const dir = repo();
  writeFileSync(join(dir, "staged"), "one"); git(dir, "add", ".");
  writeFileSync(join(dir, "untracked"), "two");
  const info = await inspectWorkspace(dir);
  expect(info.error).toBeUndefined(); expect(info.total).toBe(2); expect(info.base).toBe("New repository");
});

test("missing repositories are explicit and large file sets are capped", async () => {
  expect((await inspectWorkspace("/nonexistent-am-workspace-test")).available).toBe(false);
  const dir = repo();
  for (let i = 0; i < 205; i++) writeFileSync(join(dir, `file-${i}`), "x");
  const info = await inspectWorkspace(dir);
  expect(info.total).toBe(205); expect(info.files).toHaveLength(200);
});

test("concurrent reads share one inspection", async () => {
  let calls = 0;
  const result = { available: false, files: [], total: 0, pullRequests: [] };
  const load = async () => { calls++; await Bun.sleep(5); return result; };
  const key = `test-${crypto.randomUUID()}`;
  const values = await Promise.all([cachedWorkspace(key, load), cachedWorkspace(key, load)]);
  expect(calls).toBe(1); expect(values).toEqual([result, result]);
});


test("PR lookup pins the repository and current branch, and returns safe links", async () => {
  const dir = repo();
  writeFileSync(join(dir, "file"), "x"); git(dir, "add", "."); git(dir, "commit", "-m", "base");
  git(dir, "remote", "add", "origin", "git@github.com:owner/repo.git");
  const bin = join(dir, ".test-bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
[ "$3" = "--repo" ] && [ "$4" = "owner/repo" ] && [ "$5" = "--head=main" ] || exit 1
printf '%s' '[{"number":12,"title":"A PR","state":"OPEN","isDraft":true,"url":"javascript:bad"}]'
`);
  chmodSync(join(bin, "gh"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = bin + ":" + previous;
  try {
    const info = await inspectWorkspace(dir);
    expect(info.pullRequestsError).toBeUndefined();
    expect(info.pullRequests).toEqual([{ number: 12, title: "A PR", state: "OPEN", isDraft: true, url: "https://github.com/owner/repo/pull/12" }]);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    const failed = await inspectWorkspace(dir);
    expect(failed.available).toBe(true); expect(failed.pullRequestsError).toContain("PR lookup unavailable");
  } finally { process.env.PATH = previous; }
});


test("workspace paths retain trailing spaces", async () => {
  const parent = repo();
  const dir = join(parent, "workspace "); mkdirSync(dir);
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "new-file"), "x");
  const info = await inspectWorkspace(dir);
  expect(info.error).toBeUndefined();
  expect(info.files.map(file => file.path)).toEqual(["new-file"]);
});


test("diff previews cover branch, worktree, deleted and literal pathspec files", async () => {
  const dir = repo();
  writeFileSync(join(dir, "tracked.txt"), "before\n");
  writeFileSync(join(dir, "deleted.txt"), "deleted\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "base"); git(dir, "switch", "-c", "feature");
  writeFileSync(join(dir, "tracked.txt"), "committed\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "change");
  writeFileSync(join(dir, "tracked.txt"), "after\n");
  unlinkSync(join(dir, "deleted.txt"));
  const diff = await inspectWorkspaceDiff(dir, "tracked.txt");
  expect(diff.diff).toContain("-before"); expect(diff.diff).toContain("+after");
  expect((await inspectWorkspaceDiff(dir, "deleted.txt")).diff).toContain("-deleted");
  await expect(inspectWorkspaceDiff(dir, "../secret")).rejects.toThrow("Invalid file path");
  await expect(inspectWorkspaceDiff(dir, "/etc/passwd")).rejects.toThrow("Invalid file path");
  await expect(inspectWorkspaceDiff(dir, ":(glob)*")).rejects.toThrow("no longer");
});

test("untracked previews are bounded and reject symlinks", async () => {
  const dir = repo();
  writeFileSync(join(dir, "new.txt"), "new content\n");
  expect((await inspectWorkspaceDiff(dir, "new.txt")).diff).toContain("+new content");
  writeFileSync(join(dir, "large.txt"), "a".repeat(300000));
  expect((await inspectWorkspaceDiff(dir, "large.txt")).truncated).toBe(true);
  writeFileSync(join(dir, "binary"), Buffer.from([1, 0, 2]));
  expect((await inspectWorkspaceDiff(dir, "binary")).binary).toBe(true);
  symlinkSync("/etc/passwd", join(dir, "link"));
  await expect(inspectWorkspaceDiff(dir, "link")).rejects.toThrow("symlinks");
});
