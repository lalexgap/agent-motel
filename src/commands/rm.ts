import { readAgent, removeAgent, resolveAgent, setStatus, type AgentState } from "../state";
import { queueClear, queueDepth } from "../queue";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { acquireProducerLock, releaseProducerLock } from "../mailbox";
import { hasUnfinishedDelivery } from "../messages";
import { displayStatus } from "./ls";
import { removeSubagents } from "../subagents";
import { removeSnapshot } from "../snapshots";
import { trashState } from "../trash";
import { hasSession, killSession } from "../tmux";
import { CODEX_STOP_BUDGET_MS, codexDeadline, releaseCodexTrust, stopCodexDaemonWork } from "../codexDaemon";
import { acquireLifecycleLock, currentLifecycleAgent, lifecycleLockHeld, releaseLifecycleLock } from "../lifecycle";

// Stop = kill the tmux session but keep state, so `am resume` still works.
// The SessionEnd hook never fires for a killed session, so mark it ourselves.
function stopAgentLocked(agent: AgentState): void {
  const current = currentLifecycleAgent(agent);
  if (hasSession(current.tmuxSession)) killSession(current.tmuxSession);
  stopCodexDaemonWork(current);
  setStatus(current.name, "exited", "stopped by operator");
}

export function stopAgent(agent: AgentState, opts: { lifecycleLocked?: boolean } = {}): void {
  if (opts.lifecycleLocked) {
    if (!lifecycleLockHeld(agent.name)) throw new Error("stop requires the agent lifecycle lock");
    stopAgentLocked(agent);
    return;
  }
  if (!acquireLifecycleLock(agent.name)) throw new Error(`agent "${agent.name}" is being stopped, removed, renamed, or restarted — retry`);
  try {
    stopAgentLocked(agent);
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

export type StopIfIdleReason = "busy" | "queued" | "in_turn";
export type IdleRefusal = { ok: false; error: string; reason: StopIfIdleReason };
export type StopIfIdleResult = { ok: true } | IdleRefusal;

const STOP_IF_IDLE_WAIT_MS = 10_000;
// A handover this close before the idle transition may be one the turn that
// just ended never saw (hook and clock skew), so it still counts.
const HANDOFF_GRACE_MS = 2_000;

// A message handed over without a receipt shows only as lastHandoffAt until
// the agent's prompt hook marks it working; a later idle means it took it.
// A prompt after the handover whose turn has already ended also does, which
// keeps a turn shorter than the grace from blocking the stop for good.
function handedOverSinceIdle(agent: AgentState, status: string): boolean {
  if (!agent.lastHandoffAt || status === "dead") return false;
  const handoffAt = Date.parse(agent.lastHandoffAt);
  const idleAt = Date.parse(agent.statusChangedAt ?? "");
  if (!Number.isFinite(idleAt)) return true;
  const promptAt = Date.parse(agent.promptAt ?? "");
  if (promptAt >= handoffAt && idleAt >= promptAt) return false;
  return handoffAt > idleAt - (agent.lastHandoffInTurn ? 0 : HANDOFF_GRACE_MS);
}

// Run `act` only on an agent with nothing to do: idle, nothing queued, no
// delivered message still in its turn. Checked and run under the delivery and
// producer locks, so no delivery or enqueue can land in between. A mailbox
// still busy at the deadline is a delivery in progress, so busy. `act` runs
// holding both locks, so it must not deliver or enqueue itself.
export async function runIfIdle<T>(
  agent: AgentState,
  act: (current: AgentState) => T,
): Promise<{ ok: true; value: T } | IdleRefusal> {
  const name = agent.name;
  for (const deadline = Date.now() + STOP_IF_IDLE_WAIT_MS; ;) {
    if (acquireDeliverLock(name)) {
      try {
        if (acquireProducerLock(name)) {
          try {
            const current = readAgent(name) ?? agent;
            const status = displayStatus(current);
            if (status === "working" || status === "starting" || status === "waiting" || status === "needs-attention") {
              return { ok: false, error: `agent "${name}" is ${status}`, reason: "busy" };
            }
            // Nothing can drain a dead or exited agent's queue, and the stop keeps it for resume.
            const queued = status === "dead" || status === "exited" ? 0 : queueDepth(name);
            if (queued > 0) return { ok: false, error: `agent "${name}" has ${queued} queued message(s)`, reason: "queued" };
            if (handedOverSinceIdle(current, status)) {
              return { ok: false, error: `agent "${name}" was handed a message it has not started on yet`, reason: "in_turn" };
            }
            if (hasUnfinishedDelivery(name)) {
              return { ok: false, error: `agent "${name}" has a delivered message whose turn has not finished`, reason: "in_turn" };
            }
            return { ok: true, value: act(current) };
          } finally {
            releaseProducerLock(name);
          }
        }
      } finally {
        releaseDeliverLock(name);
      }
    }
    if (Date.now() >= deadline) return { ok: false, error: `agent "${name}" mailbox is busy`, reason: "busy" };
    await Bun.sleep(100);
  }
}

export async function stopIfIdle(agent: AgentState): Promise<StopIfIdleResult> {
  try {
    const result = await runIfIdle(agent, (current) => stopAgent(current));
    return result.ok ? { ok: true } : result;
  } catch (error) {
    return { ok: false, error: (error as Error).message, reason: "busy" };
  }
}

function destroyAgentLocked(agent: AgentState, clean: boolean): void {
  const current = currentLifecycleAgent(agent);
  if (hasSession(current.tmuxSession)) killSession(current.tmuxSession);
  const deadline = codexDeadline(CODEX_STOP_BUDGET_MS);
  stopCodexDaemonWork(current, deadline);

  if (clean && current.worktreePath && current.repoRoot) {
    const result = Bun.spawnSync([
      "git", "-C", current.repoRoot,
      "worktree", "remove", "--force", current.worktreePath,
    ]);
    if (result.exitCode !== 0) {
      console.error(`warning: failed to remove worktree: ${result.stderr.toString().trim()}`);
    } else {
      console.log(`removed worktree ${current.worktreePath}`);
    }
  }

  // Snapshot the state before deleting it so an accidental rm is recoverable
  // with `am restore`. The conversation (and, without --clean, the worktree)
  // survive rm untouched, so the snapshot is all that's needed to bring it
  // back; restore checks the dir at recovery time and recreates the worktree
  // from its branch if --clean had removed it.
  trashState(current);

  queueClear(current.name);
  removeSnapshot(current.name);
  // Otherwise a later agent reusing the name inherits this one's subagents —
  // including records left open by a kill that fired no Stop hook.
  removeSubagents(current.name);
  removeAgent(current.name);
  if (current.codexTrustedDir) releaseCodexTrust(current.codexTrustedDir, current.name, deadline);
}

export function destroyAgent(agent: AgentState, opts: { clean: boolean; lifecycleLocked?: boolean }): void {
  if (opts.lifecycleLocked) {
    if (!lifecycleLockHeld(agent.name)) throw new Error("remove requires the agent lifecycle lock");
    destroyAgentLocked(agent, opts.clean);
    return;
  }
  if (!acquireLifecycleLock(agent.name)) throw new Error(`agent "${agent.name}" is being stopped, removed, renamed, or restarted — retry`);
  try {
    destroyAgentLocked(agent, opts.clean);
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

export function rmCommand(prefix: string, opts: { clean: boolean }): void {
  const agent = resolveAgent(prefix);
  destroyAgent(agent, opts);
  console.log(`removed agent "${agent.name}"`);
}
