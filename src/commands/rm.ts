import { removeAgent, resolveAgent, setStatus, type AgentState } from "../state";
import { queueClear } from "../queue";
import { removeSnapshot } from "../snapshots";
import { trashState } from "../trash";
import { hasSession, killSession } from "../tmux";

// Stop = kill the tmux session but keep state, so `am resume` still works.
// The SessionEnd hook never fires for a killed session, so mark it ourselves.
export function stopAgent(agent: AgentState): void {
  if (hasSession(agent.tmuxSession)) killSession(agent.tmuxSession);
  setStatus(agent.name, "exited");
}

export function destroyAgent(agent: AgentState, opts: { clean: boolean }): void {
  if (hasSession(agent.tmuxSession)) killSession(agent.tmuxSession);

  if (opts.clean && agent.worktreePath && agent.repoRoot) {
    const result = Bun.spawnSync([
      "git", "-C", agent.repoRoot,
      "worktree", "remove", "--force", agent.worktreePath,
    ]);
    if (result.exitCode !== 0) {
      console.error(`warning: failed to remove worktree: ${result.stderr.toString().trim()}`);
    } else {
      console.log(`removed worktree ${agent.worktreePath}`);
    }
  }

  // Snapshot the state before deleting it so an accidental rm is recoverable
  // with `am restore`. The conversation (and, without --clean, the worktree)
  // survive rm untouched, so the snapshot is all that's needed to bring it
  // back; restore checks the dir at recovery time and recreates the worktree
  // from its branch if --clean had removed it.
  trashState(agent);

  queueClear(agent.name);
  removeSnapshot(agent.name);
  removeAgent(agent.name);
}

export function rmCommand(prefix: string, opts: { clean: boolean }): void {
  const agent = resolveAgent(prefix);
  destroyAgent(agent, opts);
  console.log(`removed agent "${agent.name}"`);
}
