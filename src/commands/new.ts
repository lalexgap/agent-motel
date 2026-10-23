import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ensureDirs, worktreesDir, expandHome } from "../paths";
import { agentNameOwner, callingAgentName, matchAgent, readAgent, recordAttached, removeAgent, writeAgent, type AgentState, type Provider } from "../state";
import { attachOrSwitch, hasSession, newSession, sessionName } from "../tmux";
import { ensureDaemon } from "../daemon";
import { loadConfig } from "../config";
import { queueAppendForAgent, queueClear } from "../queue";
import {
  agentSystemPrompt,
  buildLaunchCommand,
  CONCIERGE_NAME,
  conversationArgs,
  remoteControlArgs,
  scrubNestedSessionEnv,
} from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import {
  amTrustedCodexDir,
  CODEX_LAUNCH_BUDGET_MS,
  codexDaemonLaunch,
  codexDeadline,
  codexDaemonWanted,
  codexPreload,
  deadlineRemaining,
  missDeadline,
  startCodexThread,
  type CodexDeadline,
  type CodexThreadOpts,
} from "../codexDaemon";
import { ensureSubagentRoles } from "../subagentRoles";
import { pretrustClaudeAgentDir } from "../claudeTrust";
import { CONCIERGE_ROLE, modelForRole, providerForRole, requireRole } from "../roles";
import { providerCatalog, validateSelection } from "../catalog";

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

// New branches fork from origin's default branch (origin/HEAD, else
// origin/main or origin/master), fetched first, rather than whatever the main
// checkout happens to have checked out. A failed fetch (offline, or racing a
// concurrent fetch) still forks from the local ref — stale but the right
// branch. Undefined — fall back to HEAD — only when no such ref exists.
export async function freshBase(repoRoot: string, warn?: (msg: string) => void): Promise<string | undefined> {
  const head = git(repoRoot, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  const candidates = [...new Set([...(head.exitCode === 0 && head.stdout ? [head.stdout] : []), "origin/main", "origin/master"])];
  const base = candidates.find(
    (ref) => git(repoRoot, "rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`).exitCode === 0,
  );
  if (!base) return undefined;
  // Bounded and non-interactive: a hung remote, credential prompt, or ssh
  // passphrase/host-key prompt must not wedge `am new`.
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH_COMMAND && git(repoRoot, "config", "core.sshCommand").exitCode !== 0) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  const branch = base.slice("origin/".length);
  // Async so the sidebar's create flow keeps rendering while it runs.
  const fetch = Bun.spawn(["git", "-C", repoRoot, "fetch", "--quiet", "origin", branch], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: 15_000,
  });
  if ((await fetch.exited) !== 0) warn?.(`warning: couldn't fetch origin/${branch}; branching from the local ${base}`);
  return base;
}

export async function createWorktree(
  name: string,
  branch: string,
  baseDir: string,
  opts: { base?: string; warn?: (msg: string) => void } = {},
): Promise<{ path: string; repoRoot: string }> {
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
  if (branchExists && opts.base) throw new Error(`branch ${branch} already exists — --base only applies to a new branch`);
  let base: string | undefined;
  if (opts.base) {
    // Resolve in the caller's dir: `--base HEAD` from inside an agent's
    // worktree means that worktree's HEAD, not the main checkout's.
    const resolved = git(baseDir, "rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`);
    if (resolved.exitCode !== 0) throw new Error(`--base: unknown ref "${opts.base}"`);
    base = resolved.stdout;
  } else if (!branchExists) {
    base = await freshBase(repoRoot, opts.warn);
  }
  const args = branchExists
    ? ["worktree", "add", path, branch]
    : base
      ? ["worktree", "add", "--no-track", "-b", branch, path, base]
      : ["worktree", "add", "-b", branch, path];
  const result = git(repoRoot, ...args);
  if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr}`);
  return { path, repoRoot };
}

export function agentEnv(name: string): Record<string, string> {
  return {
    AGENTMGR_AGENT: name,
    // Tells SessionStart this process loaded the inbound-accepting settings.
    AGENTMGR_PEER_INBOX: "1",
    ...(process.env.AGENTMGR_HOME ? { AGENTMGR_HOME: process.env.AGENTMGR_HOME } : {}),
  };
}

export interface NewOptions {
  name: string;
  message?: string;
  dir?: string;
  worktree?: string;
  // Start point for a new worktree branch; default is origin's freshly
  // fetched default branch (see freshBase).
  base?: string;
  provider?: Provider;
  // Optional model override; undefined = the provider's default model.
  model?: string;
  // Optional reasoning-effort override; undefined = the provider default.
  effort?: string;
  role?: string;
  // Internal lifecycle override: preserve the original role snapshot even if
  // the registry changed since the source agent was created.
  roleInstructions?: string;
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
  // Set only by ensureConcierge: allows creating the reserved concierge agent.
  concierge?: boolean;
}

// Without a thread up front, hooks fall back to matching the launch by dir.
async function createCodexThread(opts: CodexThreadOpts, deadline: CodexDeadline, quiet?: boolean): Promise<string | undefined> {
  try {
    return await startCodexThread(opts, { timeoutMs: deadlineRemaining(deadline) });
  } catch (error) {
    if (/timed out/.test((error as Error).message)) missDeadline(deadline);
    else if (!quiet) console.error(`warning: could not create the codex thread up front (${(error as Error).message}) — starting it from the TUI`);
    return undefined;
  }
}

export async function newCommand(opts: NewOptions): Promise<void> {
  const { name } = opts;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("agent name must be alphanumeric with dashes/underscores");
  }
  if (name === CONCIERGE_NAME && !opts.concierge) {
    throw new Error(`"${CONCIERGE_NAME}" is reserved for the fleet concierge — open it with \`am concierge\` (c in the hub)`);
  }
  if (opts.role === CONCIERGE_ROLE && !opts.concierge) {
    throw new Error(`role "${CONCIERGE_ROLE}" is reserved for the fleet concierge — open it with \`am concierge\``);
  }
  const owner = agentNameOwner(name);
  if (owner) {
    if (owner.name === name) throw new Error(`agent "${name}" already exists — restart it with \`am resume ${name}\``);
    throw new Error(`agent name "${name}" is retained as an alias for "${owner.name}"`);
  }
  const session = sessionName(name);
  if (hasSession(session)) throw new Error(`tmux session ${session} already exists`);
  const role = opts.role
    ? (opts.roleInstructions ? { name: opts.role, instructions: opts.roleInstructions } : requireRole(opts.role))
    : undefined;
  const roleInstructions = opts.roleInstructions ?? role?.instructions;
  // A role may pin its provider (`am role provider <name> --claude`);
  // an explicit --claude/--codex still wins, as does a snapshotted role on
  // resume/move, where the agent's own provider is passed in.
  const provider = providerForRole(opts.role, loadConfig().defaultProvider, opts.provider);
  let model = modelForRole(opts.role, provider, opts.model);
  // Fail loudly now rather than spawning a tmux session that dies instantly
  // ("command not found" with no surviving error) — bit handoffs on machines
  // without the other provider installed.
  if (!Bun.which(provider)) {
    throw new Error(`${provider} is not installed on this machine — install it or pick the other provider (--claude / --codex)`);
  }
  // A bogus --model/--effort otherwise reaches the provider as a flag it
  // rejects, and the session dies before anyone sees the message.
  if (model || opts.effort) {
    const catalog = providerCatalog(provider);
    const roleModel = !opts.model && model ? model : undefined;
    let complaints = validateSelection(catalog, { model, effort: opts.effort });
    // A role default naming a model this machine's provider doesn't offer (an
    // older CLI, a different account) must not block the spawn — drop to the
    // provider's own default instead, then re-check: the effort was validated
    // against the unknown model's levels, and the default model's may differ.
    if (roleModel && complaints.some((c) => c.fatal && c.message.includes(`model "${roleModel}"`))) {
      if (!opts.quiet) console.error(`warning: unknown ${provider} model "${roleModel}" from role "${opts.role}" — using the ${provider} default`);
      model = undefined;
      complaints = validateSelection(catalog, { effort: opts.effort });
    }
    for (const complaint of complaints) {
      if (complaint.fatal) throw new Error(`${complaint.message} (see \`am models\`)`);
      if (!opts.quiet) console.error(`warning: ${complaint.message}`);
    }
  }

  ensureDirs();
  if (!(await ensureDaemon())) {
    console.error("warning: daemon failed to start — falling back to hook-only delivery");
  }

  let hooksChanged = false;
  if (provider === "codex") hooksChanged = ensureCodexHooks().changed;
  // Same idea for the roles: the providers' agent files must match the
  // registry before a session that might delegate to them starts.
  ensureSubagentRoles();

  // Expand ~ ourselves rather than leaning on the shell: a --dir routed over
  // ssh arrives single-quoted (shQuote), so the remote shell never expands it.
  let dir = resolve(expandHome(opts.dir ?? process.cwd()));
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
    const wt = await createWorktree(name, worktreeBranch, dir, {
      base: opts.base,
      warn: opts.quiet ? undefined : (msg) => console.error(msg),
    });
    dir = wt.path;
    worktreePath = wt.path;
    repoRoot = wt.repoRoot;
  }

  // Who created this agent? Any `am` call inside a managed session carries
  // AGENTMGR_AGENT — lets `--report` default to "whoever made me".
  const inheritedSpawner = callingAgentName();
  const spawnedBy = inheritedSpawner ? (matchAgent(inheritedSpawner)?.name ?? inheritedSpawner) : undefined;
  const reportTo = opts.reportTo ?? (opts.report ? spawnedBy : undefined);
  if (opts.report && !reportTo && !opts.quiet) {
    console.error("warning: --report but no spawning agent — set a target with --report-to <name>");
  }

  // Persisted even when this launch falls back to in-process.
  const codexDaemon = provider === "codex" ? (opts.remote ?? loadConfig().remoteControl) : undefined;
  const deadline = codexDeadline(CODEX_LAUNCH_BUDGET_MS);
  const codexDaemonRequested = codexDaemonWanted(!!codexDaemon, !!opts.continue || opts.resume === true);
  const codexDaemonLaunched = provider === "codex" ? codexDaemonLaunch(codexDaemonRequested, dir, deadline) : undefined;
  let codexDaemonAttached = codexDaemonLaunched && typeof opts.resume === "string" ? codexPreload(opts.resume, deadline, undefined, { model, effort: opts.effort }) : codexDaemonLaunched;
  const codexThreadId = codexDaemonAttached && !opts.resume && !opts.continue
    ? await createCodexThread({ cwd: dir, name, model, effort: opts.effort, bypass: loadConfig().skipPermissions }, deadline, opts.quiet)
    : undefined;
  // A daemon that stopped answering would hang the attached TUI too.
  if (codexDaemonAttached && deadline.missed) {
    console.error("warning: the codex app-server daemon didn't respond in time — launching codex in-process (no remote control)");
    codexDaemonAttached = false;
  }
  const plan = buildLaunchCommand(provider, name, {
    ...opts,
    resume: codexThreadId ?? opts.resume,
    // The thread carries these too, but an attached TUI starts each turn
    // with its own model and effort, so it needs them as well.
    model,
    effort: opts.effort,
    reportTo,
    role: role?.name,
    roleInstructions,
    codexDaemonDir: codexDaemonAttached ? dir : undefined,
  });

  if (provider === "claude") pretrustClaudeAgentDir(dir);

  const now = new Date().toISOString();
  const state: AgentState = {
    name,
    status: "starting",
    statusReason: "launching",
    statusChangedAt: now,
    dir,
    tmuxSession: session,
    provider,
    model,
    effort: opts.effort,
    codexDaemon,
    codexDaemonAttached,
    codexTrustedDir: codexDaemonLaunched ? amTrustedCodexDir(dir) : undefined,
    sessionId: codexThreadId,
    worktreePath,
    worktreeBranch,
    repoRoot,
    task: opts.message,
    role: role?.name,
    roleInstructions,
    reportTo,
    spawnedBy,
    createdAt: now,
    updatedAt: now,
  };
  // Register the agent BEFORE its queue and session exist: the SessionStart
  // hook reads the state file to drain the queue, and gc's orphan scan treats
  // a queue without a registered owner as garbage.
  writeAgent(state);
  // Queue before the session starts so the SessionStart hook finds it.
  if (plan.deferredMessage) queueAppendForAgent(name, plan.deferredMessage);

  try {
    newSession({ session, dir, env: agentEnv(name), command: scrubNestedSessionEnv(plan.command) });
  } catch (error) {
    removeAgent(name);
    queueClear(name);
    throw error;
  }

  if (!opts.quiet) console.log(`started agent "${name}" in ${dir}`);
  // Quiet callers (the concierge, the HTTP API, `am run`) still need this one:
  // until it is answered the agent sits at the trust prompt, reporting nothing
  // and never picking up its queued task. Goes to stderr so it stays out of
  // whatever a quiet caller is printing.
  if (hooksChanged) {
    const notice = `codex will ask to review am's hooks on startup — choose "Trust all and continue" (one-time; without it status tracking stays blind)`;
    if (opts.quiet) console.error(`warning: ${notice}`);
    else console.log(`  ${notice}`);
  }

  const jump = opts.jump ?? (!!process.stdout.isTTY && !!process.stdin.isTTY);
  if (jump) {
    recordAttached(name);
    attachOrSwitch(session);
  } else if (!opts.quiet) {
    console.log(`  jump to it:  am j ${name}`);
  }
}
