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
export type StopIfIdleResult = { ok: true } | { ok: false; error: string; reason: StopIfIdleReason };

const STOP_IF_IDLE_WAIT_MS = 10_000;

// Stop only an agent with nothing to do: idle, nothing queued, no delivered
// message still in its turn. Checked and stopped under the delivery and
// producer locks, so no delivery or enqueue can land in between. A mailbox
// still busy at the deadline is a delivery in progress, so busy.
export async function stopIfIdle(agent: AgentState): Promise<StopIfIdleResult> {
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
            const queued = queueDepth(name);
            if (queued > 0) return { ok: false, error: `agent "${name}" has ${queued} queued message(s)`, reason: "queued" };
            if (hasUnfinishedDelivery(name)) {
              return { ok: false, error: `agent "${name}" has a delivered message whose turn has not finished`, reason: "in_turn" };
            }
            stopAgent(current);
            return { ok: true };
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
