import { existsSync } from "node:fs";
import { agentProvider, resolveAgent, updateAgentStatus, writeAgent, type AgentState, type Provider } from "../state";
import { hasSession, newSession } from "../tmux";
import { ensureDaemon } from "../daemon";
import { queueAppend, queuePopId } from "../queue";
import { buildResumeCommand, fanOutChangeMessage, scrubNestedSessionEnv } from "../providers";
import { CONCIERGE_ROLE, roleForAgent } from "../roles";
import { loadConfig } from "../config";
import { ensureCodexHooks } from "../codexHooks";
import { agentEnv } from "./new";

export interface ResumeOpts {
  message?: string;
  remote?: boolean;
  // Change the agent's fan-out preference as it comes back up. Persisted, so
  // it survives this resume and every later one; undefined leaves it alone.
  preferSubagents?: boolean;
}

export interface ResumeOverrides {
  // Shown under the "resumed agent" line, when the change needs explaining.
  note?: string;
  // Delivered to the agent on its way back up, for a provider that can't be
  // handed a fresh system prompt.
  message?: string;
  // The stored value actually changed, so a failed launch has something to
  // roll back.
  stored?: boolean;
}

// How a changed fan-out preference reaches the resumed session:
//   claude — rebuilt into its primer (`--append-system-prompt`);
//   codex  — no system-prompt flag, so the new instruction is queued as a
//            message, the way `am new --resume` already re-primes a codex
//            agent with its role. It lands at the first turn, not at launch.
// The concierge is the exception: its primer IS its role instructions, and
// fleet management doesn't fan out, so the setting can't apply at all.
export function preferenceEffect(
  provider: Provider,
  role: string | undefined,
  preferSubagents: boolean,
): ResumeOverrides {
  const target = preferSubagents ? "prefer its own subagents" : "prefer am agents";
  if (role === CONCIERGE_ROLE) {
    return { note: `saved, but "${CONCIERGE_ROLE}" runs on its role instructions alone — fan-out guidance doesn't apply to it` };
  }
  if (provider !== "codex") return {};
  return {
    note: `saved: ${target} — codex takes it as a message before its next turn, not in its primer`,
    message: fanOutChangeMessage(preferSubagents),
  };
}

// Apply the overrides this resume carries before the launch command is built
// from the agent's state.
export function applyResumeOverrides(agent: AgentState, opts: ResumeOpts): ResumeOverrides {
  if (opts.preferSubagents === undefined) return {};
  const stored = opts.preferSubagents !== agent.preferSubagents;
  // An unset preference follows config, so a flag matching the config default
  // pins the value without changing how the agent behaves — worth storing,
  // not worth re-instructing the agent about. Re-resuming with the same flag
  // (shell history, a retry after a crash) changes nothing either.
  const effective = agent.preferSubagents ?? loadConfig().preferSubagents;
  agent.preferSubagents = opts.preferSubagents;
  if (opts.preferSubagents === effective) return { stored };
  return { ...preferenceEffect(agentProvider(agent), roleForAgent(agent), opts.preferSubagents), stored };
}

// Codex takes `-m` as a launch positional, so it starts that task straight
// away — a queued instruction would be typed in mid-turn. Fold the change into
// the prompt instead, so the very first turn already runs under it.
export function foldChangeIntoPrompt(
  provider: Provider,
  change: string | undefined,
  message: string | undefined,
): { message?: string; queue?: string } {
  if (!change) return { message };
  if (provider !== "codex" || !message) return { message, queue: change };
  return { message: `${change}\n\n${message}` };
}

// Bring an exited/dead agent back to life, resuming its conversation. Quiet
// (no console output) so the picker and sidebar can call it too. The agent's
// own fan-out preference rides along in its state, so the rebuilt primer
// matches the one it launched with.
export async function reviveAgent(
  agent: AgentState,
  opts: ResumeOpts = {},
): Promise<string | null> {
  if (hasSession(agent.tmuxSession)) return null; // already live
  if (!existsSync(agent.dir)) throw new Error(`agent directory no longer exists: ${agent.dir}`);

  // Before buildResumeCommand: the primer is built from the agent's state.
  const previous = agent.preferSubagents;
  const overrides = applyResumeOverrides(agent, opts);
  const provider = agentProvider(agent);
  await ensureDaemon();
  if (provider === "codex") ensureCodexHooks();

  const folded = foldChangeIntoPrompt(provider, overrides.message, opts.message);
  const plan = buildResumeCommand(provider, agent, { ...opts, message: folded.message });
  // Persist before launching, like `am new` does: the SessionStart hook does a
  // read-modify-write of this file, so a write after launch can be clobbered.
  if (overrides.stored) writeAgent(agent);

  // Queue before the session starts so the SessionStart hook finds it.
  const queued: string[] = [];
  if (folded.queue) queued.push(queueAppend(agent.name, folded.queue));
  if (plan.deferredMessage) queued.push(queueAppend(agent.name, plan.deferredMessage));

  try {
    newSession({
      session: agent.tmuxSession,
      dir: agent.dir,
      env: agentEnv(agent.name),
      command: scrubNestedSessionEnv(plan.command),
    });
  } catch (error) {
    // Nothing came up. Take back what this call queued and un-store the
    // preference: leaving it stored would make the retry a no-op, and the
    // agent would come back never having been told.
    for (const id of queued) queuePopId(agent.name, id);
    if (overrides.stored) {
      agent.preferSubagents = previous;
      writeAgent(agent);
    }
    throw error;
  }
  updateAgentStatus(agent, "starting", "resuming");
  writeAgent(agent);
  return overrides.note ?? null;
}

export async function resumeCommand(prefix: string, opts: ResumeOpts): Promise<void> {
  const agent = resolveAgent(prefix);
  if (hasSession(agent.tmuxSession)) {
    throw new Error(
      `agent "${agent.name}" is already running — stop it first (\`am stop ${agent.name}\`) or jump with \`am j ${agent.name}\``,
    );
  }
  const note = await reviveAgent(agent, opts);
  console.log(`resumed agent "${agent.name}" in ${agent.dir}`);
  if (note) console.log(`  ${note}`);
  console.log(`  jump to it:  am j ${agent.name}`);
}
