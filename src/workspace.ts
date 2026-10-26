import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAgent } from "./state";

const exec = promisify(execFile);
const MAX_FILES = 200;
export interface WorkspaceFile { path: string; status: string; working: boolean; additions: number | null; deletions: number | null }
export interface WorkspaceInfo {
  available: boolean;
  branch?: string;
  base?: string;
  files: WorkspaceFile[];
  total: number;
  repository?: string;
  pullRequests: { number: number; title: string; url: string; state: string; isDraft: boolean }[];
  error?: string;
  pullRequestsError?: string;
}

async function command(dir: string, executable: string, args: string[]) {
  const result = await exec(executable, args, {
    cwd: dir, timeout: 6000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
  });
  return result.stdout;
}
function git(dir: string, ...args: string[]) {
  return command(dir, "git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "status.renames=false", ...args]);
}

export function githubRepository(remote: string): string | null {
  const match = remote.trim().match(/^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return match?.[1] ?? null;
}

export function changedFiles(names: string, stats: string, status: string): WorkspaceFile[] {
  const files = new Map<string, WorkspaceFile>();
  const add = (path: string, code: string, working: boolean) => {
    const entry = files.get(path) ?? { path, status: code, working, additions: null, deletions: null };
    if (working) { entry.working = true; entry.status = code; }
    files.set(path, entry);
  };
  const parts = names.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i + 1]) add(parts[i + 1]!, parts[i]!, false);
  for (const record of status.split("\0")) {
    if (record.length > 3) add(record.slice(3), record.slice(0, 2).trim(), true);
  }
  for (const record of stats.split("\0")) {
    const first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const file = files.get(record.slice(second + 1));
    if (file) {
      const plus = record.slice(0, first), minus = record.slice(first + 1, second);
      file.additions = plus === "-" ? null : Number(plus);
      file.deletions = minus === "-" ? null : Number(minus);
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function inspectWorkspace(dir: string, includePullRequests = true): Promise<WorkspaceInfo> {
  const result: WorkspaceInfo = { available: false, files: [], total: 0, pullRequests: [] };
  let root: string;
  try { root = (await git(dir, "rev-parse", "--show-toplevel")).replace(/\n$/, ""); }
  catch { return { ...result, error: "No Git workspace available." }; }
  result.available = true;
  try {
    result.branch = (await git(root, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
    const remote = await git(root, "remote", "get-url", "origin").catch(() => "");
    result.repository = githubRepository(remote) ?? undefined;
    const defaultRef = (await git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").catch(() => "")).trim();
    let base = "HEAD";
    for (const ref of [...new Set([defaultRef, "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"].filter(Boolean))]) {
      const mergeBase = (await git(root, "merge-base", "HEAD", ref).catch(() => "")).trim();
      if (mergeBase) { base = mergeBase; result.base = ref.replace(/^refs\/(remotes|heads)\//, ""); break; }
    }
    const hasHead = await git(root, "rev-parse", "--verify", "HEAD").then(() => true, () => false);
    const diffArgs = ["--no-ext-diff", "--no-textconv", "--no-renames", "-z", base, "--"];
    const [names, stats, status] = await Promise.all([
      hasHead ? git(root, "diff", "--name-status", ...diffArgs) : Promise.resolve(""),
      hasHead ? git(root, "diff", "--numstat", ...diffArgs) : Promise.resolve(""),
      git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    ]);
    const files = changedFiles(names, stats, status);
    result.files = files.slice(0, MAX_FILES);
    result.total = files.length;
    result.base ||= hasHead ? "HEAD" : "New repository";
  } catch { result.error = "Couldn’t read Git changes. The workspace may be busy or too large."; }
  return includePullRequests ? withPullRequests(result) : result;
}


export function validateRemoteWorkspace(input: unknown): WorkspaceInfo {
  if (!input || typeof input !== "object") throw new Error("Invalid remote workspace");
  const value = input as WorkspaceInfo;
  const count = (n: unknown) => n === null || Number.isSafeInteger(n) && Number(n) >= 0;
  if (typeof value.available !== "boolean" || !Number.isSafeInteger(value.total) || value.total < 0 ||
      !Array.isArray(value.files) || value.files.length > MAX_FILES ||
      !value.files.every(file => file && typeof file.path === "string" && file.path.length <= 4096 &&
        typeof file.status === "string" && file.status.length <= 8 && count(file.additions) && count(file.deletions)))
    throw new Error("Invalid remote workspace");
  for (const field of ["branch", "base", "repository", "error", "pullRequestsError"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field]!.length > 4096))
      throw new Error("Invalid remote workspace");
  }
  return { available: value.available, total: value.total, files: value.files.map(file => ({
    path: file.path, status: file.status, working: file.working === true, additions: file.additions, deletions: file.deletions,
  })), branch: value.branch, base: value.base, repository: value.repository, error: value.error, pullRequests: [] };
}

export async function withPullRequests(workspace: WorkspaceInfo): Promise<WorkspaceInfo> {
  const result = { ...workspace, pullRequests: [] as WorkspaceInfo["pullRequests"] };
  if (typeof result.repository === "string" && githubRepository(`https://github.com/${result.repository}`) === result.repository &&
      typeof result.branch === "string" && result.branch.length > 0 && result.branch.length <= 1024) {
    try {
      const output = await command(process.cwd(), "gh", ["pr", "list", "--repo", result.repository, `--head=${result.branch}`, "--state", "all", "--limit", "10", "--json", "number,title,state,isDraft"]);
      const prs = JSON.parse(output);
      if (!Array.isArray(prs)) throw new Error("invalid PR response");
      result.pullRequests = prs.filter(pr => Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.title === "string")
        .map(pr => ({ number: pr.number, title: pr.title, state: ["OPEN", "CLOSED", "MERGED"].includes(pr.state) ? pr.state : "UNKNOWN", isDraft: pr.isDraft === true,
          url: `https://github.com/${result.repository}/pull/${pr.number}` }));
      delete result.pullRequestsError;
    } catch { result.pullRequestsError = "PR lookup unavailable. Check GitHub CLI access on the server."; }
  }
  return result;
}

const cache = new Map<string, { until: number; pending: boolean; value: Promise<WorkspaceInfo> }>();
export function cachedWorkspace(key: string, load: () => Promise<WorkspaceInfo>): Promise<WorkspaceInfo> {
  const found = cache.get(key);
  if (found && (found.pending || found.until > Date.now())) return found.value;
  cache.delete(key);
  if (cache.size >= 64) {
    const stale = [...cache].find(([, entry]) => !entry.pending);
    if (stale) cache.delete(stale[0]);
    else return Promise.reject(new Error("Workspace inspection busy. Try again shortly."));
  }
  const entry = { until: 0, pending: true, value: Promise.resolve().then(load) };
  cache.set(key, entry);
  entry.value = entry.value.finally(() => { entry.pending = false; entry.until = Date.now() + 15_000; });
  return entry.value;
}
export function agentWorkspace(name: string, includePullRequests = true) {
  const agent = readAgent(name);
  if (!agent) throw new Error(`no local agent "${name}"`);
  return cachedWorkspace(`local:${includePullRequests}:${agent.name}:${agent.createdAt}:${agent.dir}`, () => inspectWorkspace(agent.dir, includePullRequests));
}

export interface WorkspaceDiff { path: string; diff: string; binary: boolean; truncated: boolean }
const MAX_DIFF = 256 * 1024;

export async function inspectWorkspaceDiff(dir: string, path: string): Promise<WorkspaceDiff> {
  if (!path || path.includes("\0") || isAbsolute(path) || path.split("/").includes("..")) throw new Error("Invalid file path");
  const workspace = await inspectWorkspace(dir, false);
  const file = workspace.files.find(file => file.path === path);
  if (!file) throw new Error("File is no longer in the changed files list. Refresh changes and try again.");
  const root = (await git(dir, "rev-parse", "--show-toplevel")).replace(/\n$/, "");
  let diff = "";
  if (file.status === "??") {
    const filename = resolve(root, path), resolved = await realpath(filename), inside = relative(await realpath(root), resolved);
    if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside) || !(await lstat(filename)).isFile())
      throw new Error("Diff previews do not follow untracked symlinks or special files");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
      const buffer = Buffer.alloc(MAX_DIFF + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) return { path, diff: "Binary file", binary: true, truncated: false };
      const content = buffer.subarray(0, Math.min(bytesRead, MAX_DIFF)).toString("utf8");
      const lines = content ? content.split("\n") : [];
      if (content.endsWith("\n")) lines.pop();
      diff = `--- /dev/null\n+++ b/${path}\n`;
      if (lines.length) {
        diff += `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => "+" + line).join("\n") + "\n";
        if (!content.endsWith("\n") && bytesRead <= MAX_DIFF) diff += "\\ No newline at end of file\n";
      }
      return { path, diff: diff.slice(0, MAX_DIFF), binary: false, truncated: bytesRead > MAX_DIFF || diff.length > MAX_DIFF };
    } finally { await handle.close(); }
  }
  const base = workspace.base === "New repository" ? null : workspace.base === "HEAD" ? "HEAD" :
    (await git(root, "merge-base", "HEAD", workspace.base!)).trim();
  const args = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=3"];
  if (base) diff = await git(root, "--literal-pathspecs", "diff", ...args, base, "--", path);
  else diff = (await git(root, "--literal-pathspecs", "diff", "--cached", ...args, "--", path)) +
    (await git(root, "--literal-pathspecs", "diff", ...args, "--", path));
  return { path, diff: diff.slice(0, MAX_DIFF), binary: /^Binary files .* differ$/m.test(diff), truncated: diff.length > MAX_DIFF };
}

export function agentWorkspaceDiff(name: string, path: string): Promise<WorkspaceDiff> {
  const agent = readAgent(name);
  if (!agent) throw new Error(`no local agent "${name}"`);
  return inspectWorkspaceDiff(agent.dir, path);
}
