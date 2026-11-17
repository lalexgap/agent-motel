import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { stopAgent } from "./commands/rm";
import { applyDevPoolCleanup, planDevPoolCleanup, type DevPoolCleanupPlan } from "./cleanupDevPool";
import { acquireDeliverLock, releaseDeliverLock } from "./deliver";
import { acquireLifecycleLock, currentLifecycleAgent, releaseLifecycleLock } from "./lifecycle";
import { acquireProducerLock, releaseProducerLock } from "./mailbox";
import { outboxTake } from "./outbox";
import { outboxDir, outboxFile, planFile, handoffsDir } from "./paths";
import { queueClearEntries, queueDepth, queueList } from "./queue";
import { decisionStoreFile } from "./decisions";
import { agentNamesAndAliases, readAgent, updateAgentStatus, writeAgent, type AgentState } from "./state";
import { activeSubagents, closeOpenSubagents } from "./subagents";
import { hasSession } from "./tmux";
import { stopCodexDaemonWork } from "./codexDaemon";
import { canonicalPath, withWorktreeDeletionLock, worktreeCommitSafety, worktreeOwnerReason, worktreeSafety } from "./worktreeOwnership";

export interface CleanupBlocker {
  reason: string;
  forceable: boolean;
  files?: string[];
}

export interface CleanupPlan {
  name: string;
  createdAt: string;
  remove: string[];
  keep: string[];
  blockers: CleanupBlocker[];
  token: string;
  branch: string | null;
  prs: string[];
  prStates?: { url: string; state: string }[];
  worktree?: string;
  devPool?: DevPoolCleanupPlan;
  applied?: boolean;
  forced?: boolean;
  cleanedAt?: string;
}

const GIT_TIMEOUT_MS = 10_000;
const NESTED_LIMIT = 200_000;

function git(path: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", path, ...args], {
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function nestedRepositoryReason(path: string): string | null {
  const stage = git(path, "ls-files", "--stage", "-z");
  if (!stage.ok) return "could not check for nested git repositories";
  for (const entry of stage.out.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const target = join(path, entry.slice(entry.indexOf("\t") + 1));
    try {
      if (readdirSync(target).length > 0) return "contains a nested git repository (submodule)";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "could not check for nested git repositories";
    }
  }

  let budget = NESTED_LIMIT;
  const walk = (dir: string, root: boolean): string | null => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "could not check for nested git repositories";
    }
    for (const entry of entries) {
      if (budget-- <= 0) return "could not check for nested git repositories";
      if (entry.name === ".git") {
        if (!root) return "contains a nested git repository";
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const found = walk(join(dir, entry.name), false);
      if (found) return found;
    }
    return null;
  };
  return walk(path, true);
}

function registrationBlocker(agent: AgentState): string | null {
  const path = agent.worktreePath!;
  const top = git(path, "rev-parse", "--show-toplevel");
  const common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const admin = git(path, "rev-parse", "--absolute-git-dir");
  if (!top.ok || !common.ok || !admin.ok) return "worktree path or registration is unknown";
  try {
    if (canonicalPath(top.out) !== canonicalPath(path)) return "worktree path is not a checkout root";
    if (canonicalPath(common.out) === canonicalPath(admin.out)) return "refusing to remove the primary checkout";
    if (!agent.repoRoot || canonicalPath(dirname(common.out)) !== canonicalPath(agent.repoRoot)) return "worktree registration changed";
  } catch {
    return "worktree path or registration is unknown";
  }
  return null;
}

function managedAgentDirBlocker(agent: AgentState): string | null {
  if (!agent.worktreePath) return null;
  try {
    if (!isAbsolute(agent.dir) || !isAbsolute(agent.worktreePath)) return "agent directory is outside its managed worktree";
    const rel = relative(canonicalPath(agent.worktreePath), canonicalPath(agent.dir));
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return null;
  } catch { /* invalid or unreadable paths fail closed */ }
  return "agent directory is outside its managed worktree";
}

function addBlocker(plan: CleanupPlan, reason: string, forceable: boolean, files?: string[]): void {
  if (plan.blockers.some((blocker) => blocker.reason === reason)) return;
  plan.blockers.push({ reason, forceable, ...(files?.length ? { files } : {}) });
}

function basePlan(agent: AgentState): CleanupPlan {
  const names = agentNamesAndAliases(agent);
  const prStates = (agent.prMonitor?.pullRequests ?? []).map((pr) => ({ url: pr.url, state: pr.state }));
  const outboxClaims = (() => {
    try {
      const prefixes = names.map((name) => basename(outboxFile(name), ".jsonl") + ".");
      return readdirSync(outboxDir()).filter((file) => file.endsWith(".claimed.jsonl") && prefixes.some((prefix) => file.startsWith(prefix)));
    } catch {
      return [];
    }
  })();
  const keep = [
    `agent state for ${agent.name}`,
    ...(agent.transcriptPath ? [agent.transcriptPath] : ["conversation transcript"]),
    planFile(agent.name),
    decisionStoreFile(agent.name),
    handoffsDir(),
    ...(outboxClaims.length ? [`${outboxClaims.length} in-flight outbox claim${outboxClaims.length === 1 ? "" : "s"}`] : []),
    ...(agent.worktreeBranch ? [`branch ${agent.worktreeBranch}`] : []),
    ...prStates.map((pr) => `${pr.state.toLowerCase()} PR ${pr.url}`),
  ];
  const queued = queueDepth(agent.name);
  const subagents = activeSubagents(agent.name).length;
  const remove = [
    ...(hasSession(agent.tmuxSession) ? [`tmux session ${agent.tmuxSession}`] : []),
    ...(subagents ? [`${subagents} active subagent${subagents === 1 ? "" : "s"}`] : []),
    ...(queued ? [`${queued} queued message${queued === 1 ? "" : "s"}`] : []),
    ...names.map(outboxFile).filter(existsSync),
  ];
  return {
    name: agent.name,
    createdAt: agent.createdAt,
    remove: [...new Set(remove)],
    keep: [...new Set(keep)],
    blockers: [],
    token: "",
    branch: agent.worktreeBranch ?? null,
    prs: prStates.map((pr) => pr.url),
    ...(prStates.length ? { prStates } : {}),
    ...(agent.worktreePath ? { worktree: agent.worktreePath } : {}),
  };
}

function planCore(agent: AgentState, devPool?: DevPoolCleanupPlan): CleanupPlan {
  const plan = basePlan(agent);
  if (process.env.TMUX && agentNamesAndAliases(agent).includes(process.env.AGENTMGR_AGENT?.trim() ?? "") && hasSession(agent.tmuxSession)) {
    addBlocker(plan, "refusing to clean the agent session running this command", false);
  }
  const metadata = [agent.worktreePath, agent.worktreeBranch, agent.repoRoot].filter(Boolean).length;
  if (metadata === 0) {
    plan.keep.push(agent.dir);
    return plan;
  }
  if (metadata !== 3) {
    addBlocker(plan, "managed worktree metadata is incomplete", false);
    return plan;
  }
  const path = agent.worktreePath!;
  const agentDir = managedAgentDirBlocker(agent);
  if (agentDir) addBlocker(plan, agentDir, false);
  if (!existsSync(path)) {
    plan.keep.push(`${path} (already absent)`);
    return plan;
  }
  const branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (!branch.ok || !branch.out) {
    addBlocker(plan, "worktree HEAD is detached or its branch is unknown", false);
  } else {
    plan.branch = branch.out;
    plan.keep = [...plan.keep.filter((item) => !item.startsWith("branch ")), `branch ${branch.out}`];
  }
  plan.remove.unshift(path);

  const registration = registrationBlocker(agent);
  if (registration) addBlocker(plan, registration, false);
  const owner = worktreeOwnerReason(path, agent);
  const ownPoolLease = owner?.startsWith("owned by dev-pool slot-") &&
    devPool?.remove.some((item) => item.includes("dev-pool slot-") && item.includes(`(${canonicalPath(path)})`)) &&
    !devPool.blockers.some((reason) => reason.includes("belongs to another agent"));
  if (owner && !ownPoolLease) addBlocker(plan, owner, false);

  const safety = worktreeSafety(path, agent.repoRoot);
  if (safety?.kind === "dirty") {
    const ignored = safety.files?.filter((file) => file.code === "!!").map((file) => file.path) ?? [];
    const dirty = safety.files?.filter((file) => file.code !== "!!").map((file) => file.path) ?? [];
    if (dirty.length) addBlocker(plan, `uncommitted files: ${dirty.join(", ")}`, true, dirty);
    if (ignored.length) addBlocker(plan, `ignored files: ${ignored.join(", ")}`, true, ignored);
    if (!dirty.length && !ignored.length) addBlocker(plan, safety.reason, true);
  } else if (safety) {
    addBlocker(plan, safety.reason, false);
  }

  const commits = worktreeCommitSafety(path, { requirePushed: true });
  if (commits) addBlocker(plan, commits.reason, commits.kind === "unpushed");

  const nested = nestedRepositoryReason(path);
  if (nested) addBlocker(plan, nested, false);
  return plan;
}

function mergeDevPool(plan: CleanupPlan, devPool: DevPoolCleanupPlan): CleanupPlan {
  plan.devPool = devPool;
  plan.remove.push(...devPool.remove);
  for (const reason of devPool.blockers) addBlocker(plan, reason, false);
  plan.remove = [...new Set(plan.remove)];
  return plan;
}

function gitSnapshot(path: string, excludes: string[] = []): unknown {
  if (!existsSync(path)) return { absent: true };
  const excluded = new Set(excludes);
  const command = (...args: string[]) => {
    const result = git(path, ...args);
    return result.ok ? result.out : { error: result.err || "git command failed" };
  };
  const listed = (value: unknown) => typeof value === "string" ? value.split("\0").filter((file) => file && !excluded.has(file)) : value;
  const untracked = listed(command("ls-files", "--others", "--exclude-standard", "-z"));
  const ignored = listed(command("ls-files", "--others", "--ignored", "--exclude-standard", "-z"));
  const files = [untracked, ignored].flatMap((value) => Array.isArray(value) ? value : []);
  const metadata = files.sort().map((file) => {
    try {
      const stat = statSync(join(path, file));
      return [file, stat.mode, stat.size, stat.mtimeMs];
    } catch {
      return [file, "unreadable"];
    }
  });
  return {
    head: command("rev-parse", "HEAD"),
    index: command("ls-files", "--stage", "-z"),
    status: (() => {
      const value = command("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored");
      return typeof value === "string"
        ? value.split("\0").filter((entry) => entry && !(["?? ", "!! "].includes(entry.slice(0, 3)) && excluded.has(entry.slice(3))))
        : value;
    })(),
    tracked: command("diff", "--binary", "--no-ext-diff"),
    staged: command("diff", "--cached", "--binary", "--no-ext-diff"),
    untracked,
    ignored,
    metadata,
  };
}

interface ConfirmedGitState { snapshot: unknown; excludes: string[] }

function confirmedGitState(agent: AgentState, plan: CleanupPlan): ConfirmedGitState | undefined {
  if (!agent.worktreePath) return undefined;
  const excludes = plan.devPool?.dbName ? ["tmp/.dev-stack-db"] : [];
  return { snapshot: gitSnapshot(agent.worktreePath, excludes), excludes };
}

function finalizePlan(agent: AgentState, plan: CleanupPlan, confirmedGit = confirmedGitState(agent, plan)): CleanupPlan {
  const resources = plan.remove.flatMap((item) => {
    try {
      const stat = statSync(item);
      return [[item, stat.mode, stat.size, stat.mtimeMs]];
    } catch {
      return [];
    }
  });
  plan.token = createHash("sha256").update(JSON.stringify({
    name: plan.name,
    createdAt: plan.createdAt,
    worktree: plan.worktree,
    branch: plan.branch,
    prs: plan.prStates,
    blockers: plan.blockers,
    remove: resources,
    queue: queueList(agent.name).map((entry) => [entry.msgId, entry.queuedAt]),
    devPool: plan.devPool ? { remove: plan.devPool.remove, blockers: plan.devPool.blockers, fingerprint: plan.devPool.fingerprint } : undefined,
    git: confirmedGit?.snapshot,
  })).digest("hex");
  return plan;
}

export async function planCleanup(agent: AgentState): Promise<CleanupPlan> {
  const current = readAgent(agent.name);
  if (!current || current.createdAt !== agent.createdAt) throw new Error(`agent "${agent.name}" changed — preview cleanup again`);
  const devPool = planDevPoolCleanup(current);
  return finalizePlan(current, mergeDevPool(planCore(current, devPool), devPool));
}

function blocking(plan: CleanupPlan, force: boolean): CleanupBlocker[] {
  return plan.blockers.filter((blocker) => !force || !blocker.forceable);
}

function blockerError(plan: CleanupPlan, force: boolean): Error {
  return new Error(`cleanup blocked: ${blocking(plan, force).map((blocker) => blocker.reason).join("; ")}`);
}

function removeWorktree(agent: AgentState, force: boolean, confirmedGit: ConfirmedGitState | undefined): void {
  const path = agent.worktreePath;
  if (!path || !existsSync(path)) return;
  let failure: string | null = null;
  const lockFailure = withWorktreeDeletionLock(() => {
    const current = readAgent(agent.name);
    if (!current || current.createdAt !== agent.createdAt) {
      failure = `agent "${agent.name}" changed during cleanup`;
      return;
    }
    const registration = registrationBlocker(current);
    const branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD");
    const branchFailure = !branch.ok || branch.out !== current.worktreeBranch ? "worktree branch changed during cleanup" : null;
    const owner = worktreeOwnerReason(path, current);
    const safety = worktreeSafety(path, current.repoRoot);
    const commit = worktreeCommitSafety(path, { requirePushed: true });
    const nested = nestedRepositoryReason(path);
    if (registration || branchFailure || owner || nested || (safety && (!force || safety.kind !== "dirty")) || (commit && (!force || commit.kind !== "unpushed"))) {
      failure = registration ?? branchFailure ?? owner ?? nested ?? safety?.reason ?? commit?.reason ?? "worktree cleanup became unsafe";
      return;
    }
    if (!confirmedGit || JSON.stringify(gitSnapshot(path, confirmedGit.excludes)) !== JSON.stringify(confirmedGit.snapshot)) {
      failure = "worktree changed after cleanup confirmation; worktree retained";
      return;
    }
    const result = Bun.spawnSync([
      "git", "-C", agent.repoRoot!, "worktree", "remove", ...(force ? ["--force"] : []), path,
    ], { timeout: 60_000, killSignal: "SIGKILL" });
    if (result.exitCode !== 0) failure = result.stderr.toString().trim() || "git worktree remove failed";
  });
  if (lockFailure) throw new Error(lockFailure);
  if (failure) throw new Error(failure);
}

export async function cleanupAgent(
  expected: AgentState,
  opts: { force?: boolean; expectedCreatedAt?: string; expectedToken?: string } = {},
): Promise<CleanupPlan> {
  if (opts.expectedCreatedAt && opts.expectedCreatedAt !== expected.createdAt) {
    throw new Error(`agent "${expected.name}" changed — preview cleanup again`);
  }
  if (!acquireLifecycleLock(expected.name)) throw new Error(`agent "${expected.name}" lifecycle is busy — retry cleanup`);
  let deliver = false;
  let producer = false;
  try {
    let agent = currentLifecycleAgent(expected);
    if (opts.expectedCreatedAt && agent.createdAt !== opts.expectedCreatedAt) throw new Error(`agent "${agent.name}" changed — preview cleanup again`);
    if (!(deliver = acquireDeliverLock(agent.name))) throw new Error(`agent "${agent.name}" mailbox is busy — retry cleanup`);
    if (!(producer = acquireProducerLock(agent.name))) throw new Error(`agent "${agent.name}" mailbox is busy — retry cleanup`);

    const previewDevPool = planDevPoolCleanup(agent);
    const preflight = finalizePlan(agent, mergeDevPool(planCore(agent, previewDevPool), previewDevPool));
    if (opts.expectedToken && opts.expectedToken !== preflight.token) throw new Error(`cleanup plan changed — preview cleanup again`);
    if (blocking(preflight, !!opts.force).length) throw blockerError(preflight, !!opts.force);

    if (preflight.branch && agent.worktreeBranch !== preflight.branch) {
      agent.worktreeBranch = preflight.branch;
      writeAgent(agent);
    }

    if (!stopCodexDaemonWork(agent)) throw new Error(`could not stop ${agent.name}'s Codex daemon turn; cleanup refused`);
    stopAgent(agent, { lifecycleLocked: true });
    agent = currentLifecycleAgent(agent);

    const devPool = planDevPoolCleanup(agent);
    const pendingPlan = mergeDevPool(planCore(agent, devPool), devPool);
    const confirmedGit = confirmedGitState(agent, pendingPlan);
    const plan = finalizePlan(agent, pendingPlan, confirmedGit);
    if (plan.token !== preflight.token) throw new Error("cleanup plan changed while stopping the agent — worktree retained");
    if (blocking(plan, !!opts.force).length) throw blockerError(plan, !!opts.force);

    const devPoolResult = applyDevPoolCleanup(plan.devPool!);

    const cleanedAt = new Date().toISOString();
    agent.cleanedAt = cleanedAt;
    delete agent.workingSince;
    updateAgentStatus(agent, "exited", "cleaned; resume recreates the worktree");
    writeAgent(agent);

    try {
      removeWorktree(agent, !!opts.force, confirmedGit);
    } catch (error) {
      delete agent.cleanedAt;
      const removed = devPoolResult.removed;
      updateAgentStatus(agent, "exited", removed.length
        ? `cleanup partially completed; removed ${removed.join(", ")}; worktree and messages retained`
        : "cleanup failed; worktree and messages retained");
      writeAgent(agent);
      if (removed.length) throw new Error(`cleanup partially completed: removed ${removed.join(", ")}; worktree and messages retained: ${(error as Error).message}`);
      throw error;
    }
    try {
      closeOpenSubagents(agent.name);
      queueClearEntries(agent.name);
      const names = agentNamesAndAliases(agent);
      outboxTake(names);
      const remaining = names.map(outboxFile).filter(existsSync);
      if (remaining.length) throw new Error(`outbox files remain: ${remaining.join(", ")}`);
    } catch (error) {
      updateAgentStatus(agent, "exited", "cleaned; mailbox cleanup incomplete; resume recreates the worktree");
      writeAgent(agent);
      throw new Error(`worktree cleaned but mailbox cleanup failed: ${(error as Error).message}`);
    }
    return { ...plan, applied: true, forced: !!opts.force, cleanedAt };
  } finally {
    if (producer) releaseProducerLock(expected.name);
    if (deliver) releaseDeliverLock(expected.name);
    releaseLifecycleLock(expected.name);
  }
}
