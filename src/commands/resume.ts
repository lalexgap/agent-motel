import { reserveAntigravityLaunch, stopAntigravity, failAntigravityLaunch } from "../antigravity";
import { acquireLifecycleLock, currentLifecycleAgent, lifecycleLockHeld, releaseLifecycleLock } from "../lifecycle";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { existsSync } from "node:fs";
import { agentProvider, agentSessionId, resolveAgent, updateAgentStatus, writeAgent, type AgentState, providerBinary } from "../state";
import { hasSession, newSession } from "../tmux";
import { ensureDaemon } from "../daemon";
import { queueAppendForAgent } from "../queue";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import {
  amTrustedCodexDir,
  CODEX_LAUNCH_BUDGET_MS,
  codexDaemonLaunch,
  codexDeadline,
  codexDaemonWanted,
  codexPreload,
  releaseCodexTrust,
  type CodexDeadline,
} from "../codexDaemon";
import { agentEnv } from "./new";
import { pretrustClaudeAgentDir } from "../claudeTrust";

export interface ResumeOpts {
  message?: string;
  remote?: boolean;
}

// An explicit --remote/--no-remote switches the saved mode for good.
// Mutates agent.codexDaemon/codexDaemonAttached/codexTrustedDir; the caller
// writes it.
export function codexResumeDaemon(
  agent: AgentState,
  opts: ResumeOpts,
  deadline: CodexDeadline = codexDeadline(CODEX_LAUNCH_BUDGET_MS),
  load?: Parameters<typeof codexPreload>[2],
): boolean {
  if (agentProvider(agent) !== "codex") return false;
  if (opts.remote !== undefined) agent.codexDaemon = opts.remote;
  const threadId = agentSessionId(agent);
  const requested = codexDaemonWanted(!!agent.codexDaemon, !threadId);
  const launched = codexDaemonLaunch(requested, agent.dir, deadline);
  // After `am cd`, the old dir's entry is released once the new one is in use.
  const previous = agent.codexTrustedDir;
  const trusted = launched ? amTrustedCodexDir(agent.dir) : undefined;
  agent.codexTrustedDir = trusted ?? (previous === agent.dir ? previous : undefined);
  if (previous && previous !== agent.codexTrustedDir) releaseCodexTrust(previous, agent.name, deadline);
  agent.codexDaemonAttached = launched && !!threadId && codexPreload(threadId, deadline, load, { model: agent.model, effort: agent.effort });
  return agent.codexDaemonAttached;
}

// The agent's dir may have changed since launch (`am cd`, a restore).
export function claudeResumeTrust(agent: AgentState): void {
  if (agentProvider(agent) === "claude") pretrustClaudeAgentDir(agent.dir);
}

// Bring an exited/dead agent back to life, resuming its conversation. Quiet
// (no console output) so the picker and sidebar can call it too.
export async function reviveAgent(agent: AgentState, opts: ResumeOpts = {}, internal: {lifecycleLocked?:boolean} = {}): Promise<void> {
  if(agentProvider(agent)==="antigravity")return reviveAntigravity(agent,opts,!!internal.lifecycleLocked);
  if (hasSession(agent.tmuxSession)) return; // already live
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);

  const provider = agentProvider(agent);
  await ensureDaemon();
  if (provider === "codex") ensureCodexHooks();
  claudeResumeTrust(agent);

  const plan = buildResumeCommand(provider, agent, { ...opts, codexDaemon: codexResumeDaemon(agent, opts) });
  // Queue before the session starts so the SessionStart hook finds it.
  if (plan.deferredMessage) queueAppendForAgent(agent.name, plan.deferredMessage);

  updateAgentStatus(agent, "starting", "resuming");
  writeAgent(agent);
  newSession({
    session: agent.tmuxSession,
    dir: agent.dir,
    env: agentEnv(agent.name, provider),
    command: scrubNestedSessionEnv(plan.command),
  });
}

// All revive callers (restore, picker and API included) share this barrier.
// A missing pane is not evidence that its detached provider group was stopped.
async function reviveAntigravity(expected:AgentState, opts:ResumeOpts, locked:boolean):Promise<void> {
  if(locked && !lifecycleLockHeld(expected.name))throw new Error("Antigravity revive requires the caller's lifecycle lock");
  if(!locked && !acquireLifecycleLock(expected.name))throw new Error(`agent "${expected.name}" lifecycle is busy — retry resume`);
  try {
    let agent=currentLifecycleAgent(expected);
    if(hasSession(agent.tmuxSession))return;
    if(!existsSync(agent.dir))throw new Error(`agent directory no longer exists: ${agent.dir}`);
    if(!Bun.which(providerBinary("antigravity"),{PATH:process.env.PATH}))throw new Error("agy is not installed — install Antigravity CLI and sign in first; see docs/antigravity.md");
    const plan=buildResumeCommand("antigravity",agent,opts);
    if(!acquireDeliverLock(agent.name))throw new Error(`agent "${agent.name}" mailbox is busy — retry resume`);
    try {
      stopAntigravity(agent);
      await ensureDaemon();
      agent=reserveAntigravityLaunch(agent,plan);
      updateAgentStatus(agent,"starting","resuming reserved Antigravity generation");writeAgent(agent);
      try {
        newSession({session:agent.tmuxSession,dir:agent.dir,env:agentEnv(agent.name,"antigravity"),command:scrubNestedSessionEnv(plan.command)});
      } catch(error) {
        failAntigravityLaunch(agent);
        throw error;
      }
    } finally {releaseDeliverLock(agent.name);}
  } finally {if(!locked)releaseLifecycleLock(expected.name);}
}

export async function resumeCommand(prefix: string, opts: ResumeOpts): Promise<void> {
  const agent = resolveAgent(prefix);
  if (hasSession(agent.tmuxSession)) {
    throw new Error(
      `agent "${agent.name}" is already running — stop it first (\`am stop ${agent.name}\`) or jump with \`am j ${agent.name}\``,
    );
  }
  await reviveAgent(agent, opts);
  console.log(`resumed agent "${agent.name}" in ${agent.dir}`);
  console.log(`  jump to it:  am j ${agent.name}`);
}
