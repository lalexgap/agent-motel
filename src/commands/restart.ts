import { auditOperation } from "../audit";
import { existsSync } from "node:fs";
import { agentProvider, agentSessionId, resolveAgent, updateAgentStatus, writeAgent, type AgentState, providerBinary } from "../state";
import { hasSession, newSession, restartSession } from "../tmux";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { ensureDaemon } from "../daemon";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import { queueAppendForAgent } from "../queue";
import { checkSelection, providerCatalog } from "../catalog";
import { agentEnv } from "./new";
import { codexResumeDaemon, type ResumeOpts } from "./resume";
import { runIfIdle, type IdleRefusal } from "./rm";
import { CODEX_LAUNCH_BUDGET_MS, CODEX_STOP_BUDGET_MS, codexDeadline, stopCodexDaemonWork } from "../codexDaemon";
import { acquireLifecycleLock, currentLifecycleAgent, releaseLifecycleLock } from "../lifecycle";

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
function restartLocked(agent: AgentState, opts: RestartOpts): RestartResult {
  return auditOperation(agent.name, "restart", () => restartAudited(agent, opts));
}

function restartAudited(agent: AgentState, opts: RestartOpts): RestartResult {
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);
  const provider = agentProvider(agent);
  const executable = Bun.which(providerBinary(provider), { PATH: process.env.PATH });
  if (!executable) throw new Error(`${provider} executable not found in PATH`);
  if (!agentSessionId(agent)) throw new Error(`agent "${agent.name}" has no saved conversation ID — restart cannot resume it safely`);
  // Re-checked on the re-read agent: a concurrent restart may have changed the half this one keeps.
  validateChange(agent, opts);
  if (provider === "codex") ensureCodexHooks();
  const previous = { model: agent.model, effort: agent.effort, status: agent.status, reason: agent.statusReason };
  // Saved on the agent, so every later resume launches with them too.
  Object.assign(agent, nextSelection(agent, opts));
  // The old turn survives the pane respawn in the daemon. One deadline for
  // stop + relaunch; a daemon that misses it during the stop is skipped
  // for the relaunch.
  const deadline = codexDeadline(CODEX_LAUNCH_BUDGET_MS);
  stopCodexDaemonWork(agent, codexDeadline(CODEX_STOP_BUDGET_MS, deadline));
  const plan = buildResumeCommand(provider, agent, { ...opts, codexDaemon: codexResumeDaemon(agent, opts, deadline) });
  if (provider !== "antigravity") plan.command[0] = executable;
  if (plan.deferredMessage) queueAppendForAgent(agent.name, plan.deferredMessage);
  const launch = {
    session: agent.tmuxSession,
    dir: agent.dir,
    env: { ...agentEnv(agent.name, provider), ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
    command: scrubNestedSessionEnv(plan.command),
  };
  updateAgentStatus(agent, "starting", "restarting");
  writeAgent(agent);
  try {
    if (hasSession(agent.tmuxSession)) restartSession(launch);
    else newSession(launch);
  } catch (error) {
    agent.model = previous.model;
    agent.effort = previous.effort;
    updateAgentStatus(agent, previous.status, previous.reason);
    writeAgent(agent);
    throw error;
  }
  return { model: agent.model ?? null, effort: agent.effort ?? null };
}

function lifecycleBusy(name: string): string {
  return `agent "${name}" is being stopped, removed, renamed, or restarted — retry restart`;
}

export async function restartAgent(prefix: string, opts: RestartOpts = {}): Promise<RestartResult> {
  await ensureDaemon();
  let agent = resolveAgent(prefix);
  validateChange(agent, opts, { refresh: true, warn: (message) => console.error(message) });
  if (!acquireLifecycleLock(agent.name)) throw new Error(lifecycleBusy(agent.name));
  try {
    agent = currentLifecycleAgent(agent);
    if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" is busy or being moved — retry restart`);
    try {
      return restartLocked(agent, opts);
    } finally {
      releaseDeliverLock(agent.name);
    }
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

// Restart only an agent with nothing to do, under the same checks as
// `am stop --if-idle`.
export async function restartIfIdle(prefix: string, opts: RestartOpts = {}): Promise<({ ok: true } & RestartResult) | IdleRefusal> {
  await ensureDaemon();
  const agent = resolveAgent(prefix);
  validateChange(agent, opts, { refresh: true, warn: (message) => console.error(message) });
  const result = await runIfIdle(agent, { releaseProducer: true }, (current) => {
    if (!acquireLifecycleLock(current.name)) return null;
    try {
      return restartLocked(currentLifecycleAgent(current), opts);
    } finally {
      releaseLifecycleLock(current.name);
    }
  });
  if (!result.ok) return result;
  if (!result.value) return { ok: false, error: lifecycleBusy(agent.name), reason: "busy" };
  return { ok: true, ...result.value };
}

export async function restartCommand(prefix: string, opts: RestartOpts & { ifIdle?: boolean; json?: boolean }): Promise<void> {
  const { ifIdle, json, ...restart } = opts;
  if (ifIdle) {
    // Prints the outcome either way; a refusal is {ok: false, error, reason}.
    const result = await restartIfIdle(prefix, restart);
    if (json) console.log(JSON.stringify(result));
    else if (!result.ok) throw new Error(result.error);
    else console.log(`restarted agent "${resolveAgent(prefix).name}" — resumed its conversation`);
    return;
  }
  const result = await restartAgent(prefix, restart);
  if (json) console.log(JSON.stringify({ ok: true, ...result }));
  else console.log(`restarted agent "${resolveAgent(prefix).name}" — resumed its conversation${describeSelection(result)}`);
}

function describeSelection(result: RestartResult): string {
  const parts = [result.model && `model ${result.model}`, result.effort && `effort ${result.effort}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
