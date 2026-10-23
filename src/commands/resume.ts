import { existsSync } from "node:fs";
import { agentProvider, agentSessionId, resolveAgent, updateAgentStatus, writeAgent, type AgentState } from "../state";
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
  load?: (threadId: string, bypass: boolean) => boolean,
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
  agent.codexDaemonAttached = launched && !!threadId && codexPreload(threadId, deadline, load);
  return agent.codexDaemonAttached;
}

// The agent's dir may have changed since launch (`am cd`, a restore).
export function claudeResumeTrust(agent: AgentState): void {
  if (agentProvider(agent) === "claude") pretrustClaudeAgentDir(agent.dir);
}

// Bring an exited/dead agent back to life, resuming its conversation. Quiet
// (no console output) so the picker and sidebar can call it too.
export async function reviveAgent(agent: AgentState, opts: ResumeOpts = {}): Promise<void> {
  if (hasSession(agent.tmuxSession)) return; // already live
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);

  const provider = agentProvider(agent);
  await ensureDaemon();
  if (provider === "codex") ensureCodexHooks();
  claudeResumeTrust(agent);

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
