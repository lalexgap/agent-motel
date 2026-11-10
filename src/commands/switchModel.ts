import { recordAudit, withAuditContext } from "../audit";
import { findModel, providerCatalog, validateSelection } from "../catalog";
import { loadConfig } from "../config";
import { ensureDaemon, requestDaemonModelSwitch } from "../daemon";
import { deliverNext } from "../deliver";
import { queueAppendForAgent } from "../queue";
import {
  agentProvider,
  callingAgentName,
  matchAgent,
  readAgent,
  updateAgentIf,
  type AgentState,
  type PendingModelSwitch,
} from "../state";
import { restartAgent, validateChange, type RestartResult } from "./restart";

export const MODEL_SWITCH_EVENT = "model-switch";

// Providers whose conversation restart resumes on another model, and whose
// hooks report the turn end the switch waits for.
export function selfSwitchSupported(provider: string): boolean {
  return provider === "claude" || provider === "codex";
}

function describeTarget(target: { model?: string; effort?: string }): string {
  return `${target.model ?? "the provider's default model"}${target.effort ? ` at ${target.effort} effort` : ""}`;
}

export interface SwitchRequest {
  model: string;
  effort?: string;
  reason?: string;
}

// Validate a self-requested switch and record it as pending on the agent.
// Throws with the refusal; never touches the session.
export function requestModelSwitch(agentName: string | undefined, request: SwitchRequest): { agent: AgentState; pending: PendingModelSwitch } {
  const maxTurns = loadConfig().selfModelSwitchMaxTurns;
  if (!(maxTurns > 0)) throw new Error("am switch-model is disabled on this machine (selfModelSwitchMaxTurns is 0)");
  if (!agentName) {
    throw new Error("am switch-model changes the model of the agent running it; run it from inside a managed agent, or use `am restart <name> --model <model>` as the operator");
  }
  const agent = matchAgent(agentName);
  if (!agent) throw new Error(`"${agentName}" is not a managed agent on this machine — am switch-model only works from inside one`);
  const reason = request.reason?.trim();
  if (!reason) throw new Error('am switch-model requires --reason "<why>"');
  const provider = agentProvider(agent);
  if (!selfSwitchSupported(provider)) throw new Error(`am switch-model supports claude and codex agents, not ${provider}`);
  if ((agent.selfModelSwitches ?? 0) > 0) throw new Error("you have already switched your model once; am allows one self-switch per agent");
  if (agent.pendingModelSwitch) {
    throw new Error(`a switch to ${describeTarget(agent.pendingModelSwitch)} is already pending — end your turn to let it happen`);
  }
  if (agent.turns === undefined) {
    throw new Error("refused: this conversation's context age is unknown (it predates turn counting or was adopted), so a switch could re-read a large uncached context");
  }
  if (agent.turns > maxTurns) {
    throw new Error(`refused: switching is allowed only during your first ${maxTurns} turn${maxTurns === 1 ? "" : "s"} (this is turn ${agent.turns}); it re-reads the whole conversation uncached`);
  }
  const model = request.model.trim();
  if (!model) throw new Error("am switch-model requires a model (see `am models`)");
  const effort = request.effort?.trim() || undefined;
  if (model === agent.model && (effort === undefined || effort === agent.effort)) {
    throw new Error(`you are already running on ${describeTarget({ model, effort: agent.effort })}`);
  }
  // Claude's catalog is non-exhaustive, so am restart only warns on an unknown
  // model; here that would spend the one switch and persist a bad --model.
  const catalog = providerCatalog(provider, { refresh: true });
  if (!findModel(catalog, model)) {
    const why = validateSelection(catalog, { model })[0]?.message ?? `the ${provider} model catalog on this machine does not confirm "${model}"`;
    throw new Error(`refused: ${why} — a self-switch only goes to a model \`am models\` lists`);
  }
  validateChange(agent, { model, effort }, { warn: (message) => console.error(message) });
  const pending: PendingModelSwitch = { model, ...(effort ? { effort } : {}), reason, requestedAt: new Date().toISOString() };
  const recorded = updateAgentIf(agent.name, (current) => {
    if (current.createdAt !== agent.createdAt || current.pendingModelSwitch || (current.selfModelSwitches ?? 0) > 0) return false;
    current.pendingModelSwitch = pending;
    return true;
  });
  if (!recorded) throw new Error(`agent "${agent.name}" changed while the switch was being requested — retry`);
  return { agent, pending };
}

export async function switchModelCommand(model: string, opts: { effort?: string; reason?: string; json?: boolean }): Promise<void> {
  const { agent, pending } = requestModelSwitch(callingAgentName(), { model, effort: opts.effort, reason: opts.reason });
  if (opts.json) {
    console.log(JSON.stringify({ agent: agent.name, model: pending.model, effort: pending.effort ?? null, reason: pending.reason, requestedAt: pending.requestedAt, when: "end-of-turn" }));
    return;
  }
  console.log(`Switch to ${describeTarget(pending)} scheduled for the end of this turn.`);
  console.log("Finish this turn now without starting more work; am will restart you on the new model and prompt you to continue.");
  console.log("Background work still running when the turn ends (a shell, a wake-up, a background subagent) delays the switch until a turn ends without any.");
}

// A switch whose turn ended but that nothing carried out (its daemon request
// was lost), so the agent sits idle waiting for it.
const OVERDUE_MS = 30_000;
export function modelSwitchOverdue(agent: AgentState, now = Date.now()): boolean {
  const triggeredAt = Date.parse(agent.pendingModelSwitch?.triggeredAt ?? "");
  return agent.status === "idle" && Number.isFinite(triggeredAt) && now - triggeredAt > OVERDUE_MS;
}

export function continueMessage(pending: PendingModelSwitch): string {
  return `[am] You are now running on ${describeTarget(pending)} — the switch you requested (${pending.reason}). Continue the task from where you left off.`;
}

export function failureMessage(pending: PendingModelSwitch, agent: AgentState | null, why: string): string {
  return `[am] Your requested switch to ${describeTarget(pending)} did not happen: ${why}. You are still on ${agent?.model ?? "your current model"}${agent?.effort ? ` at ${agent.effort} effort` : ""}. Continue the task on it.`;
}

// Settle a pending switch that will not happen and tell the agent why,
// through its queue. A `spent` attempt counts as its one self-switch.
// Returns whether a message was queued.
export function abandonModelSwitch(name: string, pending: PendingModelSwitch, why: string, opts: { spent?: boolean } = {}): boolean {
  updateAgentIf(name, (current) => {
    if (current.pendingModelSwitch?.requestedAt !== pending.requestedAt) return false;
    delete current.pendingModelSwitch;
    if (opts.spent) current.selfModelSwitches = (current.selfModelSwitches ?? 0) + 1;
    return true;
  });
  try {
    queueAppendForAgent(name, failureMessage(pending, readAgent(name), why));
    return true;
  } catch {
    return false;
  }
}

export function heldMessage(pending: PendingModelSwitch, what: string): string {
  return `[am] Your switch to ${describeTarget(pending)} is waiting: ${what} is still running, and the restart would kill it. It happens at the first turn end with no background work, so stop that work and end your turn — or keep working normally and the switch stays pending.`;
}

// A turn ended with background work still running: the switch stays pending
// and untriggered. Tell the agent once, through its queue, so it does not sit
// idle expecting the restart.
export function holdModelSwitch(name: string, pending: PendingModelSwitch, what: string): void {
  const first = updateAgentIf(name, (current) => {
    if (current.pendingModelSwitch?.requestedAt !== pending.requestedAt || current.pendingModelSwitch.heldNotifiedAt) return false;
    current.pendingModelSwitch.heldNotifiedAt = new Date().toISOString();
    return true;
  });
  if (!first) return;
  try {
    queueAppendForAgent(name, heldMessage(pending, what));
  } catch {
    // the agent is gone
  }
}

// The turn ended: mark the switch due and hand it to the daemon, which
// outlives the pane. Without one the switch is abandoned, with the agent told.
export async function triggerModelSwitch(
  name: string,
  pending: PendingModelSwitch,
  deps: { request?: (name: string) => Promise<boolean>; ensure?: () => Promise<boolean> } = {},
): Promise<boolean> {
  const request = deps.request ?? requestDaemonModelSwitch;
  const ensure = deps.ensure ?? ensureDaemon;
  const marked = updateAgentIf(name, (current) => {
    if (current.pendingModelSwitch?.requestedAt !== pending.requestedAt) return false;
    current.pendingModelSwitch.triggeredAt = new Date().toISOString();
    return true;
  });
  if (!marked) return false;
  if (await request(name)) return true;
  try {
    if ((await ensure()) && (await request(name))) return true;
  } catch {
    // treated as no daemon
  }
  abandonModelSwitch(name, pending, "am's daemon, which carries out the switch, is not running or predates am switch-model");
  return false;
}

class SwitchDeferred extends Error {}

const RETRIES = 5;
const RETRY_DELAY_MS = 1000;

// Carry out a due switch: restart on the requested model and resume the
// conversation with a prompt to continue. On failure the agent stays on its
// model and is told so through its queue.
export async function performModelSwitch(
  name: string,
  deps: { restart?: typeof restartAgent; retryDelayMs?: number } = {},
): Promise<"switched" | "deferred" | "failed" | "none"> {
  const restart = deps.restart ?? restartAgent;
  const agent = readAgent(name);
  const pending = agent?.pendingModelSwitch;
  if (!agent || !pending?.triggeredAt) return "none";
  const defer = (): "deferred" => {
    // Another turn started first (the operator typed into the pane): the
    // switch waits for that turn's end instead.
    updateAgentIf(name, (current) => {
      if (current.pendingModelSwitch?.requestedAt !== pending.requestedAt) return false;
      delete current.pendingModelSwitch.triggeredAt;
      return true;
    });
    return "deferred";
  };
  if (agent.status !== "idle") return defer();
  const guard = (current: AgentState) => {
    if (current.pendingModelSwitch?.requestedAt !== pending.requestedAt) throw new SwitchDeferred("superseded");
    if (current.status !== "idle") throw new SwitchDeferred("busy");
    // The restart clears the pending switch in the same write.
    current.selfModelSwitches = (current.selfModelSwitches ?? 0) + 1;
  };
  const opts = { model: pending.model, effort: pending.effort, message: continueMessage(pending) };
  let switched = false;
  try {
    await withAuditContext({ source: "self-model-switch", route: "switch-model", actor: name }, async () => {
      const requestId = recordAudit(name, "switch-model", "requested", { reason: pending.reason });
      try {
        await restartRetrying(() => restart(name, opts, guard), deps.retryDelayMs ?? RETRY_DELAY_MS);
        switched = true;
        recordAudit(name, "switch-model", "completed", { requestId, reason: pending.reason });
      } catch (error) {
        recordAudit(name, "switch-model", error instanceof SwitchDeferred ? "refused" : "failed", { requestId, reason: pending.reason });
        throw error;
      }
    });
    return "switched";
  } catch (error) {
    // Only the audit record failed; the agent is already on its new model.
    if (switched) return "switched";
    if (error instanceof SwitchDeferred) {
      if (error.message === "superseded") return "none";
      return defer();
    }
    // A failed launch already wrote the guard's count; otherwise count it
    // here. Either way the attempt is spent.
    if (abandonModelSwitch(name, pending, (error as Error).message, { spent: true })) {
      await deliverNext(name).catch(() => undefined);
    }
    return "failed";
  }
}

// Lock contention with a concurrent delivery or lifecycle command is brief.
async function restartRetrying(run: () => Promise<RestartResult>, delayMs: number): Promise<RestartResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SwitchDeferred || attempt >= RETRIES || !/— retry/.test((error as Error).message)) throw error;
      await Bun.sleep(delayMs);
    }
  }
}
