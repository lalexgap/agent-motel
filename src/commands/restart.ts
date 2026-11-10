import { stopAntigravity, reserveAntigravityLaunch, failAntigravityLaunch } from "../antigravity";
import { auditOperation } from "../audit";
import { existsSync } from "node:fs";
import { agentProvider, agentSessionId, resolveAgent, updateAgentStatus, writeAgent, type AgentState, providerBinary } from "../state";
import { hasSession, newSession, restartSession } from "../tmux";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { ensureDaemon } from "../daemon";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import { queueDeferredMessage } from "../queue";
import { checkSelection, providerCatalog } from "../catalog";
import { agentEnv } from "./new";
import { codexResumeDaemon, type ResumeOpts } from "./resume";
import { CODEX_LAUNCH_BUDGET_MS, CODEX_STOP_BUDGET_MS, codexDeadline, stopCodexDaemonWork } from "../codexDaemon";
import { acquireLifecycleLock, currentLifecycleAgent, releaseLifecycleLock } from "../lifecycle";
import { ensureAgentPlan } from "../plan";
import { displayStatus } from "./ls";

export interface RestartOpts extends ResumeOpts {
  // undefined keeps the agent's current value; null returns to the provider
  // default.
  model?: string | null;
  effort?: string | null;
}

// What the agent runs on after the restart; null = the provider default.
export interface RestartResult {
  model: string | null;
  effort: string | null;
}

export interface RestartPrecondition {
  createdAt: string;
  status: string;
}

interface Selection {
  model?: string;
  effort?: string;
}

function nextSelection(agent: AgentState, opts: RestartOpts): Selection {
  return {
    model: opts.model === undefined ? agent.model : (opts.model ?? undefined),
    effort: opts.effort === undefined ? agent.effort : (opts.effort ?? undefined),
  };
}

// A change is checked against the provider's catalog as `am new` checks it.
function validateChange(agent: AgentState, opts: RestartOpts, check: { refresh?: boolean; warn?: (message: string) => void } = {}): void {
  if (opts.model === undefined && opts.effort === undefined) return;
  const provider = agentProvider(agent);
  // Re-probed: a long-lived `am serve` must see a provider upgrade.
  checkSelection(providerCatalog(provider, { refresh: check.refresh }), nextSelection(agent, opts), check.warn);
}

// Caller holds the lifecycle and delivery locks.
function restartLocked(agent: AgentState, opts: RestartOpts, expected?: RestartPrecondition): RestartResult {
  return auditOperation(agent.name, "restart", () => restartAudited(agent, opts, expected));
}

function restartAudited(agent: AgentState, opts: RestartOpts, expected?: RestartPrecondition): RestartResult {
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);
  const provider = agentProvider(agent);
  const executable = Bun.which(providerBinary(provider), { PATH: process.env.PATH });
  if (!executable) throw new Error(`${provider} executable not found in PATH`);
  if (!agentSessionId(agent)) throw new Error(`agent "${agent.name}" has no saved conversation ID — restart cannot resume it safely`);
  // Re-checked on the re-read agent: a concurrent restart may have changed the half this one keeps.
  validateChange(agent, opts);
  if (provider === "codex") ensureCodexHooks();
  ensureAgentPlan(agent);
  const previous = { model: agent.model, effort: agent.effort, status: agent.status, reason: agent.statusReason };
  // Saved on the agent, so every later resume launches with them too.
  Object.assign(agent, nextSelection(agent, opts));
  // The old turn survives the pane respawn in the daemon. One deadline for
  // stop + relaunch; a daemon that misses it during the stop is skipped
  // for the relaunch.
  const deadline = codexDeadline(CODEX_LAUNCH_BUDGET_MS);
  stopAntigravity(agent);
  stopCodexDaemonWork(agent, codexDeadline(CODEX_STOP_BUDGET_MS, deadline));
  const plan = buildResumeCommand(provider, agent, { ...opts, codexDaemon: codexResumeDaemon(agent, opts, deadline) });
  if (!plan.antigravityRunId) plan.command[0] = executable;
  if (plan.deferredMessage) queueDeferredMessage(agent.name, plan.deferredMessage);
  if (plan.antigravityRunId) {
    const selection={model:agent.model,effort:agent.effort};
    agent=reserveAntigravityLaunch(agent,plan);
    Object.assign(agent,selection);
  } else if (provider === "antigravity") {
    delete agent.antigravityRunId;
    delete agent.antigravityRunPhase;
    delete agent.antigravityCleanupRunId;
    delete agent.workingSince;
    if (opts.message) {
      const now = new Date().toISOString();
      agent.lastHandoffAt = now;
      agent.promptAt = now;
    } else {
      delete agent.lastHandoffAt;
      delete agent.promptAt;
    }
  }
  const launch = {
    session: agent.tmuxSession,
    dir: agent.dir,
    env: { ...agentEnv(agent.name, provider), ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
    command: scrubNestedSessionEnv(plan.command),
  };
  const sessionAlive = hasSession(agent.tmuxSession);
  if (expected && !sessionAlive) {
    throw new Error(`agent "${agent.name}" stopped while the model change was starting — refresh and try again`);
  }
  updateAgentStatus(agent, "starting", "restarting");
  writeAgent(agent);
  try {
    if (sessionAlive) {
      try {restartSession(launch);}
      catch(error) {
        if(expected || provider!=="antigravity" || hasSession(agent.tmuxSession))throw error;
        newSession(launch);
      }
    } else newSession(launch);
  } catch (error) {
    if (plan.antigravityRunId) failAntigravityLaunch(agent);
    agent.model = previous.model;
    agent.effort = previous.effort;
    updateAgentStatus(agent, provider === "antigravity" ? "exited" : previous.status, provider === "antigravity" ? "restart launch failed after verified process-group cleanup" : previous.reason);
    writeAgent(agent);
    throw error;
  }
  return { model: agent.model ?? null, effort: agent.effort ?? null };
}

function lifecycleBusy(name: string): string {
  return `agent "${name}" is being stopped, removed, renamed, or restarted — retry restart`;
}

function checkPrecondition(agent: AgentState, expected?: RestartPrecondition): void {
  if (!expected) return;
  if (agent.createdAt !== expected.createdAt || displayStatus(agent) !== expected.status) {
    throw new Error(`agent "${agent.name}" changed or stopped since it was selected — refresh and try again`);
  }
}

async function restartResolvedAgent(agent: AgentState, opts: RestartOpts, expected?: RestartPrecondition): Promise<RestartResult> {
  checkPrecondition(agent, expected);
  validateChange(agent, opts, { refresh: true, warn: (message) => console.error(message) });
  if (!acquireLifecycleLock(agent.name)) throw new Error(lifecycleBusy(agent.name));
  try {
    agent = currentLifecycleAgent(agent);
    checkPrecondition(agent, expected);
    if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" is busy or being moved — retry restart`);
    try {
      return restartLocked(agent, opts, expected);
    } finally {
      releaseDeliverLock(agent.name);
    }
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

// API callers already resolved an exact name. Keep that exact incarnation
// through lifecycle acquisition instead of resolving the name a second time.
export async function restartExactAgent(agent: AgentState, opts: RestartOpts = {}, expected?: RestartPrecondition): Promise<RestartResult> {
  await ensureDaemon();
  return restartResolvedAgent(agent, opts, expected);
}

export async function restartAgent(prefix: string, opts: RestartOpts = {}): Promise<RestartResult> {
  await ensureDaemon();
  return restartResolvedAgent(resolveAgent(prefix), opts);
}

export async function restartCommand(prefix: string, opts: RestartOpts): Promise<void> {
  const result = await restartAgent(prefix, opts);
  console.log(`restarted agent "${resolveAgent(prefix).name}" — resumed its conversation${describeSelection(result)}`);
}

function describeSelection(result: RestartResult): string {
  const parts = [result.model && `model ${result.model}`, result.effort && `effort ${result.effort}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
