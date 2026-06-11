import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDirs, worktreesDir } from "../paths";
import { readAgent, recordAttached, writeAgent, type AgentState } from "../state";
import { attachOrSwitch, hasSession, newSession, sessionName } from "../tmux";
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

export function agentEnv(name: string): Record<string, string> {
  return {
    AGENTMGR_AGENT: name,
    ...(process.env.AGENTMGR_HOME ? { AGENTMGR_HOME: process.env.AGENTMGR_HOME } : {}),
  };
}

// When `am new` runs inside a Claude Code session (or the tmux server was
// started from one), spawned agents inherit the CLAUDE_CODE_* family and
// Claude Code treats them as nested child sessions — which silently disables
// conversation persistence, breaking `am resume`. Always launch claude
// through `env -u` for that family.
const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
];

export function scrubNestedSessionEnv(command: string[]): string[] {
  const vars = new Set(NESTED_SESSION_VARS);
  for (const key of Object.keys(process.env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_EFFORT") {
      vars.add(key);
    }
  }
  return ["env", ...[...vars].sort().flatMap((v) => ["-u", v]), ...command];
}

// Injected via --append-system-prompt so managed agents know they live under
// am — otherwise "spin up an agent" reaches for the built-in Task tool.
export function agentSystemPrompt(name: string): string {
  return `You are running as a managed agent named "${name}" in a tmux session controlled by the \`am\` CLI (agent-manager). Other managed agents may be running in parallel.

When asked to spin up, message, check on, or stop OTHER AGENTS, use the am CLI via Bash — not your built-in Task/subagent tool (keep that for quick scoped subtasks inside this session):
- am new <name> [-m "task"] [--dir <path> | --worktree <branch>]   (names are global, pick a unique one)
- am send <name> "msg"          queue a message, delivered when that agent goes idle
- am send <name> --now "msg"    steer its current turn immediately
- am interrupt <name> "msg"     abort its turn and redirect it
- am ls --json                  every agent's status and queue depth
- am stop <name> · am resume <name> · am rm <name>

Caveat: an agent spawned into a directory Claude Code has never trusted blocks on a trust prompt — it lingers in "starting" with no activity. Unblock it with: tmux send-keys -t 'agentmgr-<name>:' Enter`;
}

export interface NewOptions {
  name: string;
  message?: string;
  dir?: string;
  worktree?: string;
  // Adopt an existing Claude conversation: a session id, or `true` to open
  // Claude Code's interactive session picker inside the new agent.
  resume?: string | boolean;
  continue?: boolean;
  // Attach to the new session after spawning. Defaults to true when run from
  // a terminal; always false for non-TTY callers (agents spawning agents).
  jump?: boolean;
  // Suppress console output (used by the picker, which owns the screen).
  quiet?: boolean;
}

export function conversationArgs(opts: NewOptions): string[] {
  if (opts.resume && opts.continue) throw new Error("--resume and --continue are mutually exclusive");
  if (opts.resume === true) {
    if (opts.message) {
      // `claude --resume "msg"` would parse the message as a session id.
      throw new Error("-m needs a session id: use --resume <session-id>, or drop -m to pick interactively");
    }
    return ["--resume"];
  }
  if (typeof opts.resume === "string") return ["--resume", opts.resume];
  if (opts.continue) return ["--continue"];
  return [];
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

  const command = [
    "claude",
    "--settings", settingsFile,
    "--append-system-prompt", agentSystemPrompt(name),
    ...conversationArgs(opts),
  ];
  if (opts.message) command.push(opts.message);

  newSession({ session, dir, env: agentEnv(name), command: scrubNestedSessionEnv(command) });

  const now = new Date().toISOString();
  const state: AgentState = {
    name,
    status: "starting",
    dir,
    tmuxSession: session,
    worktreePath,
    worktreeBranch: opts.worktree,
    repoRoot,
    task: opts.message,
    createdAt: now,
    updatedAt: now,
  };
  writeAgent(state);

  if (!opts.quiet) console.log(`started agent "${name}" in ${dir}`);

  const jump = opts.jump ?? (!!process.stdout.isTTY && !!process.stdin.isTTY);
  if (jump) {
    recordAttached(name);
    attachOrSwitch(session);
  } else if (!opts.quiet) {
    console.log(`  jump to it:  am j ${name}`);
  }
}
