import { existsSync } from "node:fs";
import { agentProvider, resolveAgent, updateAgentStatus, writeAgent, type AgentState } from "../state";
import { hasSession, newSession } from "../tmux";
import { ensureDaemon } from "../daemon";
import { queueAppend } from "../queue";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import { agentEnv } from "./new";
import { stopAgent } from "./rm";
import { closeOpenSubagents } from "../subagents";

export interface ResumeOpts {
  message?: string;
  remote?: boolean;
  restart?: boolean;
}

// Bring an exited/dead agent back to life, resuming its conversation. Quiet
// (no console output) so the picker and sidebar can call it too.
export async function reviveAgent(agent: AgentState, opts: ResumeOpts = {}): Promise<void> {
  if (!opts.restart && hasSession(agent.tmuxSession)) return;
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);

  const provider = agentProvider(agent);
  await ensureDaemon();
  if (provider === "codex") ensureCodexHooks();

  const plan = buildResumeCommand(provider, agent, opts);
  if (opts.restart) {
    stopAgent(agent);
    if (hasSession(agent.tmuxSession)) throw new Error(`could not stop agent "${agent.name}"`);
    closeOpenSubagents(agent.name);
  }
  // Queue before the session starts so the SessionStart hook finds it.
  if (plan.deferredMessage) queueAppend(agent.name, plan.deferredMessage);

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
  if (!opts.restart && hasSession(agent.tmuxSession)) {
    throw new Error(
      `agent "${agent.name}" is already running — stop it first (\`am stop ${agent.name}\`) or jump with \`am j ${agent.name}\``,
    );
  }
  await reviveAgent(agent, opts);
  console.log(`${opts.restart ? "restarted" : "resumed"} agent "${agent.name}" in ${agent.dir}`);
  console.log(`  jump to it:  am j ${agent.name}`);
}
