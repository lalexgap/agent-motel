import { join } from "node:path";
import { tryAcquireFileLock } from "./filelock";
import { baseDir } from "./paths";
import { readAgent, type AgentState } from "./state";

const heldLocks = new Map<string, () => void>();

function lifecycleLockPath(name: string): string {
  return join(baseDir(), "locks", `lifecycle.${name}.lock`);
}

export function acquireLifecycleLock(name: string): boolean {
  const path = lifecycleLockPath(name);
  if (heldLocks.has(path)) return false;
  const release = tryAcquireFileLock(path);
  if (!release) return false;
  heldLocks.set(path, release);
  return true;
}

export function releaseLifecycleLock(name: string): void {
  const path = lifecycleLockPath(name);
  const release = heldLocks.get(path);
  if (!release) return;
  heldLocks.delete(path);
  release();
}

export function currentLifecycleAgent(expected: AgentState): AgentState {
  const current = readAgent(expected.name);
  if (
    !current ||
    current.createdAt !== expected.createdAt ||
    current.tmuxSession !== expected.tmuxSession
  ) {
    throw new Error(`agent "${expected.name}" changed while the command was starting — retry`);
  }
  return current;
}
