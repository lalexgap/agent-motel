import { readLastAttached, recordAttached, resolveAgent } from "../state";
import { attachOrSwitch, hasSession, installDetachKey } from "../tmux";

export function jumpCommand(prefix: string): void {
  const agent = resolveAgent(prefix);
  if (!hasSession(agent.tmuxSession)) {
    throw new Error(`agent "${agent.name}" has no live tmux session (status: ${agent.status})`);
  }
  recordAttached(agent.name);
  // Retrofits the ctrl-q detach binding onto sessions created before it existed.
  installDetachKey(agent.tmuxSession);
  attachOrSwitch(agent.tmuxSession);
}

export function jumpPreviousCommand(): void {
  const { previous } = readLastAttached();
  if (!previous) throw new Error("no previous agent to jump to");
  jumpCommand(previous);
}
