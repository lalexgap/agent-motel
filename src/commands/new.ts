import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDirs, worktreesDir } from "../paths";
import { readAgent, recordAttached, writeAgent, type AgentState, type Provider } from "../state";
import { attachOrSwitch, hasSession, newSession, sessionName } from "../tmux";
import { ensureDaemon } from "../daemon";
import { loadConfig } from "../config";
import { queueAppend } from "../queue";
import {
  agentSystemPrompt,
  buildLaunchCommand,
  conversationArgs,
  remoteControlArgs,
  scrubNestedSessionEnv,
} from "../providers";
import { ensureCodexHooks } from "../codexHooks";

// These grew provider-awareness and moved to providers.ts; re-exported so
// existing imports keep working.
export { agentSystemPrompt, conversationArgs, remoteControlArgs, scrubNestedSessionEnv };

function git(dir: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

export function isGitRepo(dir: string): boolean {
  return git(dir, "rev-parse", "--git-dir").exitCode === 0;
}

function createWorktree(name: string, branch: string, baseDir: string): { path: string; repoRoot: string } {
  // --git-common-dir resolves through nested worktrees to the main repo, so
  // spawning "from" another agent's worktree still files the new one under
  // the real repo's name.
  const common = git(baseDir, "rev-parse", "--git-common-dir");
  if (common.exitCode !== 0) {
    throw new Error("worktree spawning requires a git repository (--in-place runs in the dir as-is)");
  }
  const repoRoot = dirname(resolve(baseDir, common.stdout));
  const path = join(worktreesDir(), basename(repoRoot), name);
  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });

  const branchExists = git(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
  const args = branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path];
  const result = git(repoRoot, ...args);
  if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr}`);
  return { path, repoRoot };
}

export function agentEnv(name: string): Record<string, string> {
  return {
    AGENTMGR_AGENT: name,
    ...(process.env.AGENTMGR_HOME ? { AGENTMGR_HOME: process.env.AGENTMGR_HOME } : {}),
  };
}

export interface NewOptions {
  name: string;
  message?: string;
  dir?: string;
  worktree?: string;
  provider?: Provider;
  // Adopt an existing conversation: a session id, or `true` to open the
  // provider's interactive session picker inside the new agent.
  resume?: string | boolean;
  continue?: boolean;
  // Attach to the new session after spawning. Defaults to true when run from
  // a terminal; always false for non-TTY callers (agents spawning agents).
  jump?: boolean;
  // Per-agent remote-control override; undefined = config default.
  remote?: boolean;
  // Run directly in the target dir instead of a fresh worktree.
  inPlace?: boolean;
  // Standing report relationship: the agent this one keeps posted. `report`
  // (no explicit target) means "the agent that spawned me".
  reportTo?: string;
  report?: boolean;
  // Suppress console output (used by the picker, which owns the screen).
  quiet?: boolean;
}

export async function newCommand(opts: NewOptions): Promise<void> {
  const { name } = opts;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("agent name must be alphanumeric with dashes/underscores");
  }
  if (readAgent(name)) {
    throw new Error(`agent "${name}" already exists — restart it with \`am resume ${name}\``);
  }
  const session = sessionName(name);
  if (hasSession(session)) throw new Error(`tmux session ${session} already exists`);
  const provider = opts.provider ?? "claude";

  ensureDirs();
  if (!(await ensureDaemon())) {
    console.error("warning: daemon failed to start — falling back to hook-only delivery");
  }

  let hooksChanged = false;
  if (provider === "codex") hooksChanged = ensureCodexHooks().changed;

  let dir = resolve(opts.dir ?? process.cwd());
  if (!existsSync(dir)) throw new Error(`directory does not exist: ${dir}`);
  let worktreePath: string | undefined;
  let repoRoot: string | undefined;
  let worktreeBranch = opts.worktree;
  // Agents get their own worktree by default — they shouldn't assume
  // ownership of a checkout that other agents (or the human) may be using.
  if (!worktreeBranch && !opts.inPlace && loadConfig().worktreeByDefault && isGitRepo(dir)) {
    worktreeBranch = `am/${name}`;
  }
  if (worktreeBranch) {
    const wt = createWorktree(name, worktreeBranch, dir);
    dir = wt.path;
    worktreePath = wt.path;
    repoRoot = wt.repoRoot;
  }

  // Who created this agent? Any `am` call inside a managed session carries
  // AGENTMGR_AGENT — lets `--report` default to "whoever made me".
  const spawnedBy = process.env.AGENTMGR_AGENT?.trim() || undefined;
  const reportTo = opts.reportTo ?? (opts.report ? spawnedBy : undefined);
  if (opts.report && !reportTo && !opts.quiet) {
    console.error("warning: --report but no spawning agent — set a target with --report-to <name>");
  }

  const plan = buildLaunchCommand(provider, name, { ...opts, reportTo });
  // Queue before the session starts so the SessionStart hook finds it.
  if (plan.deferredMessage) queueAppend(name, plan.deferredMessage);

  newSession({ session, dir, env: agentEnv(name), command: scrubNestedSessionEnv(plan.command) });

  const now = new Date().toISOString();
  const state: AgentState = {
    name,
    status: "starting",
    dir,
    tmuxSession: session,
    provider,
    worktreePath,
    worktreeBranch,
    repoRoot,
    task: opts.message,
    reportTo,
    spawnedBy,
    createdAt: now,
    updatedAt: now,
  };
  writeAgent(state);

  if (!opts.quiet) console.log(`started agent "${name}" in ${dir}`);
  if (hooksChanged && !opts.quiet) {
    console.log(
      `  codex will ask to review am's hooks on startup — choose "Trust all and continue" (one-time; without it status tracking stays blind)`,
    );
  }

  const jump = opts.jump ?? (!!process.stdout.isTTY && !!process.stdin.isTTY);
  if (jump) {
    recordAttached(name);
    attachOrSwitch(session);
  } else if (!opts.quiet) {
    console.log(`  jump to it:  am j ${name}`);
  }
}
