import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDirs, worktreesDir } from "../paths";
import { readAgent, writeAgent, type AgentState } from "../state";
import { hasSession, newSession, sessionName } from "../tmux";
import { writeHookSettings } from "../settings";
import { ensureDaemon } from "../daemon";

function git(dir: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function createWorktree(name: string, branch: string): { path: string; repoRoot: string } {
  const top = git(process.cwd(), "rev-parse", "--show-toplevel");
  if (top.exitCode !== 0) throw new Error("--worktree requires running inside a git repository");
  const repoRoot = top.stdout;
  const path = join(worktreesDir(), basename(repoRoot), name);
  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });

  const branchExists = git(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
  const args = branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path];
  const result = git(repoRoot, ...args);
  if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr}`);
  return { path, repoRoot };
}

export interface NewOptions {
  name: string;
  message?: string;
  dir?: string;
  worktree?: string;
}

export async function newCommand(opts: NewOptions): Promise<void> {
  const { name } = opts;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("agent name must be alphanumeric with dashes/underscores");
  }
  if (readAgent(name)) throw new Error(`agent "${name}" already exists`);
  const session = sessionName(name);
  if (hasSession(session)) throw new Error(`tmux session ${session} already exists`);
  if (opts.dir && opts.worktree) throw new Error("--dir and --worktree are mutually exclusive");

  ensureDirs();
  const settingsFile = writeHookSettings();
  if (!(await ensureDaemon())) {
    console.error("warning: daemon failed to start — falling back to hook-only delivery");
  }

  let dir = resolve(opts.dir ?? process.cwd());
  let worktreePath: string | undefined;
  let repoRoot: string | undefined;
  if (opts.worktree) {
    const wt = createWorktree(name, opts.worktree);
    dir = wt.path;
    worktreePath = wt.path;
    repoRoot = wt.repoRoot;
  }
  if (!existsSync(dir)) throw new Error(`directory does not exist: ${dir}`);

  const command = ["claude", "--settings", settingsFile];
  if (opts.message) command.push(opts.message);

  newSession({
    session,
    dir,
    env: { AGENTMGR_AGENT: name, ...(process.env.AGENTMGR_HOME ? { AGENTMGR_HOME: process.env.AGENTMGR_HOME } : {}) },
    command,
  });

  const now = new Date().toISOString();
  const state: AgentState = {
    name,
    status: "starting",
    dir,
    tmuxSession: session,
    worktreePath,
    worktreeBranch: opts.worktree,
    repoRoot,
    createdAt: now,
    updatedAt: now,
  };
  writeAgent(state);

  console.log(`started agent "${name}" in ${dir}`);
  console.log(`  jump to it:  am j ${name}`);
}
