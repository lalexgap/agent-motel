import { removeAgent, resolveAgent, setStatus, type AgentState } from "../state";
import { queueClear } from "../queue";
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

  queueClear(agent.name);
  removeAgent(agent.name);
}

export function rmCommand(prefix: string, opts: { clean: boolean }): void {
  const agent = resolveAgent(prefix);
  destroyAgent(agent, opts);
  console.log(`removed agent "${agent.name}"`);
}
