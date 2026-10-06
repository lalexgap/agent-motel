import { existsSync } from "node:fs";
import { agentProvider, agentSessionId, resolveAgent, updateAgentStatus, writeAgent } from "../state";
import { hasSession, newSession, restartSession } from "../tmux";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { ensureDaemon } from "../daemon";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import { queueAppendForAgent } from "../queue";
import { agentEnv } from "./new";
import type { ResumeOpts } from "./resume";

export async function restartAgent(prefix: string, opts: ResumeOpts = {}): Promise<void> {
  await ensureDaemon();
  const agent = resolveAgent(prefix);
  if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" is busy or being moved — retry restart`);
  try {
    if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);
    const provider = agentProvider(agent);
    const executable = Bun.which(provider, { PATH: process.env.PATH });
    if (!executable) throw new Error(`${provider} executable not found in PATH`);
    if (!agentSessionId(agent)) throw new Error(`agent "${agent.name}" has no saved conversation ID — restart cannot resume it safely`);
    if (provider === "codex") ensureCodexHooks();
    const plan = buildResumeCommand(provider, agent, opts);
    plan.command[0] = executable;
    if (plan.deferredMessage) queueAppendForAgent(agent.name, plan.deferredMessage);
    const launch = {
      session: agent.tmuxSession,
      dir: agent.dir,
      env: { ...agentEnv(agent.name), ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
      command: scrubNestedSessionEnv(plan.command),
    };
    const previousStatus = agent.status;
    const previousReason = agent.statusReason;
    updateAgentStatus(agent, "starting", "restarting");
    writeAgent(agent);
    try {
      if (hasSession(agent.tmuxSession)) restartSession(launch);
      else newSession(launch);
    } catch (error) {
      updateAgentStatus(agent, previousStatus, previousReason);
      writeAgent(agent);
      throw error;
    }
  } finally {
    releaseDeliverLock(agent.name);
  }
}

export async function restartCommand(prefix: string, opts: ResumeOpts): Promise<void> {
  await restartAgent(prefix, opts);
  console.log(`restarted agent "${resolveAgent(prefix).name}" — resumed its conversation`);
}
