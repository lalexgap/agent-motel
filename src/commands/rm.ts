import { removeAgent, resolveAgent, setStatus, type AgentState } from "../state";
import { queueClear } from "../queue";
import { removeSubagents } from "../subagents";
import { removeSnapshot } from "../snapshots";
import { trashState } from "../trash";
import { hasSession, killSession } from "../tmux";
import { acquireLifecycleLock, currentLifecycleAgent, releaseLifecycleLock } from "../lifecycle";

// Stop = kill the tmux session but keep state, so `am resume` still works.
// The SessionEnd hook never fires for a killed session, so mark it ourselves.
export function stopAgent(agent: AgentState): void {
  if (!acquireLifecycleLock(agent.name)) throw new Error(`agent "${agent.name}" is being stopped, removed, renamed, or restarted — retry`);
  try {
    const current = currentLifecycleAgent(agent);
    if (hasSession(current.tmuxSession)) killSession(current.tmuxSession);
    setStatus(current.name, "exited", "stopped by operator");
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

export function destroyAgent(agent: AgentState, opts: { clean: boolean }): void {
  if (!acquireLifecycleLock(agent.name)) throw new Error(`agent "${agent.name}" is being stopped, removed, renamed, or restarted — retry`);
  try {
    const current = currentLifecycleAgent(agent);
    if (hasSession(current.tmuxSession)) killSession(current.tmuxSession);

    if (opts.clean && current.worktreePath && current.repoRoot) {
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
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

export function rmCommand(prefix: string, opts: { clean: boolean }): void {
  const agent = resolveAgent(prefix);
  destroyAgent(agent, opts);
  console.log(`removed agent "${agent.name}"`);
}
