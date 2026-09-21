import { existsSync } from "node:fs";
import { agentProvider, resolveAgent, updateAgentStatus, writeAgent, type AgentState, type Provider } from "../state";
import { hasSession, newSession } from "../tmux";
import { ensureDaemon } from "../daemon";
import { queueAppend } from "../queue";
import { buildResumeCommand, scrubNestedSessionEnv } from "../providers";
import { ensureCodexHooks } from "../codexHooks";
import { agentEnv } from "./new";

export interface ResumeOpts {
  message?: string;
  remote?: boolean;
  // Change the agent's fan-out preference as it comes back up. Persisted, so
  // it survives this resume and every later one; undefined leaves it alone.
  preferSubagents?: boolean;
}

// Changing the preference means rewriting the primer, and only claude gets a
// fresh one on resume (`--append-system-prompt`) — codex has no system-prompt
// flag, so its primer only ever rides along with a session's FIRST prompt.
// The new setting is still stored: a later handoff or `am new --resume` builds
// its prompt from it. Returns the note to show, or null. Pure.
export function preferenceNote(provider: Provider, preferSubagents: boolean | undefined): string | null {
  if (preferSubagents === undefined || provider !== "codex") return null;
  const target = preferSubagents ? "prefer its own subagents" : "prefer am agents";
  return `saved: ${target} — codex can't be re-primed on resume, so this session keeps its original instructions (a new or handed-off agent picks it up)`;
}

// Apply the overrides this resume carries before the launch command is built
// from the agent's state. Returns a note when the change can't reach the
// resumed session.
export function applyResumeOverrides(agent: AgentState, opts: ResumeOpts): string | null {
  if (opts.preferSubagents === undefined) return null;
  agent.preferSubagents = opts.preferSubagents;
  return preferenceNote(agentProvider(agent), opts.preferSubagents);
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
  const note = applyResumeOverrides(agent, opts);
  const provider = agentProvider(agent);
  await ensureDaemon();
  if (provider === "codex") ensureCodexHooks();

  const plan = buildResumeCommand(provider, agent, opts);
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
  return note;
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
