import { existsSync } from "node:fs";
import { agentProvider, resolveAgent, updateAgentStatus, writeAgent, type AgentState } from "../state";
import { hasSession, newSession } from "../tmux";
import { ensureDaemon } from "../daemon";
import { queueAppendForAgent } from "../queue";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import { amTrustedCodexDir, codexDaemonLaunch, releaseCodexTrust } from "../codexDaemon";
import { agentEnv } from "./new";

export interface ResumeOpts {
  message?: string;
  remote?: boolean;
}

// An explicit --remote/--no-remote switches the saved mode for good.
// Mutates agent.codexDaemon/codexDaemonAttached/codexTrustedDir; the caller
// writes it.
export function codexResumeDaemon(agent: AgentState, opts: ResumeOpts): boolean {
  if (agentProvider(agent) !== "codex") return false;
  if (opts.remote !== undefined) agent.codexDaemon = opts.remote;
  agent.codexDaemonAttached = codexDaemonLaunch(agent.codexDaemon ?? false, agent.dir);
  // After `am cd`, the old dir's entry is released once the new one is in use.
  const previous = agent.codexTrustedDir;
  const trusted = agent.codexDaemonAttached ? amTrustedCodexDir(agent.dir) : undefined;
  agent.codexTrustedDir = trusted ?? (previous === agent.dir ? previous : undefined);
  if (previous && previous !== agent.codexTrustedDir) releaseCodexTrust(previous, agent.name);
  return agent.codexDaemonAttached;
}

// Bring an exited/dead agent back to life, resuming its conversation. Quiet
// (no console output) so the picker and sidebar can call it too.
export async function reviveAgent(agent: AgentState, opts: ResumeOpts = {}): Promise<void> {
  if (hasSession(agent.tmuxSession)) return; // already live
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);

  const provider = agentProvider(agent);
  await ensureDaemon();
  if (provider === "codex") ensureCodexHooks();

  const plan = buildResumeCommand(provider, agent, { ...opts, codexDaemon: codexResumeDaemon(agent, opts) });
  // Queue before the session starts so the SessionStart hook finds it.
  if (plan.deferredMessage) queueAppendForAgent(agent.name, plan.deferredMessage);

  newSession({
    session: agent.tmuxSession,
    dir: agent.dir,
    env: agentEnv(agent.name),
    command: scrubNestedSessionEnv(plan.command),
  });
  updateAgentStatus(agent, "starting", "resuming");
  writeAgent(agent);
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
