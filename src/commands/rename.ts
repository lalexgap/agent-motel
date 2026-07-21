import { existsSync, renameSync } from "node:fs";
import {
  agentNameOwner,
  agentProvider,
  listAgents,
  readAgent,
  removeAgent,
  renameLastAttached,
  resolveAgent,
  writeAgent,
  type AgentState,
} from "../state";
import { inboxDir } from "../paths";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { queueAppend, queueStorageExists, renameQueue } from "../queue";
import { renameSnapshot, snapshotExists } from "../snapshots";
import { hasSession, renameSession, sessionName } from "../tmux";

export interface RenameResult {
  oldName: string;
  newName: string;
  live: boolean;
  worktreeBranch?: string;
}

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("agent name must be alphanumeric with dashes/underscores");
  }
}

function rewriteRelationships(oldName: string, newName: string): void {
  for (const related of listAgents()) {
    let changed = false;
    if (related.reportTo === oldName) {
      related.reportTo = newName;
      changed = true;
    }
    if (related.spawnedBy === oldName) {
      related.spawnedBy = newName;
      changed = true;
    }
    if (changed) writeAgent(related);
  }
}

function nextState(agent: AgentState, newName: string): AgentState {
  const aliases = [...new Set([...(agent.aliases ?? []).filter((alias) => alias !== newName), agent.name])];
  return {
    ...agent,
    name: newName,
    aliases,
    tmuxSession: sessionName(newName),
  };
}

// Rename is an identity migration, not just a label change. A live provider
// process keeps the AGENTMGR_AGENT value it inherited at launch, so the old
// name remains an alias and hooks canonicalize it through state. tmux renames
// the session in place; attached clients and active turns are uninterrupted.
export async function renameAgent(prefix: string, newName: string): Promise<RenameResult> {
  validateName(newName);
  const agent = resolveAgent(prefix);
  const oldName = agent.name;
  if (newName === oldName) return { oldName, newName, live: hasSession(agent.tmuxSession), worktreeBranch: agent.worktreeBranch };

  const owner = agentNameOwner(newName);
  if (owner && owner.name !== oldName) {
    const kind = owner.name === newName ? "agent" : `alias for "${owner.name}"`;
    throw new Error(`agent name "${newName}" is already used by ${kind}`);
  }

  const oldSession = agent.tmuxSession;
  const newSession = sessionName(newName);
  if (hasSession(newSession)) throw new Error(`tmux session ${newSession} already exists`);

  const live = hasSession(oldSession);

  if (queueStorageExists(newName)) {
    throw new Error(`queue storage already exists for "${newName}" — run \`am gc\` or choose another name`);
  }
  if (snapshotExists(newName)) {
    throw new Error(`snapshot storage already exists for "${newName}" — run \`am gc\` or choose another name`);
  }
  if (existsSync(inboxDir(newName))) {
    throw new Error(`inbox storage already exists for "${newName}" — run \`am gc\` or choose another name`);
  }

  if (!acquireDeliverLock(oldName)) {
    throw new Error(`agent "${oldName}" is receiving a queued message — retry the rename in a moment`);
  }

  const hadQueue = queueStorageExists(oldName);
  const hadSnapshot = snapshotExists(oldName);
  const hadInbox = existsSync(inboxDir(oldName));
  let stateRenamed = false;
  let sessionRenamed = false;
  try {
    renameQueue(oldName, newName);
    renameSnapshot(oldName, newName);
    if (hadInbox) renameSync(inboxDir(oldName), inboxDir(newName));
    if (live) {
      renameSession(oldSession, newSession);
      sessionRenamed = true;
    }

    // A hook may have updated status/session metadata while tmux was being
    // renamed. Carry the freshest state forward instead of overwriting it
    // with the snapshot taken during validation.
    const renamed = nextState(readAgent(oldName) ?? agent, newName);
    writeAgent(renamed);
    removeAgent(oldName);
    stateRenamed = true;
    rewriteRelationships(oldName, newName);
    renameLastAttached(oldName, newName);
  } catch (error) {
    // Before the state file changes, every artifact move is safely reversible.
    if (!stateRenamed) {
      try {
        if (hadInbox && existsSync(inboxDir(newName))) renameSync(inboxDir(newName), inboxDir(oldName));
        if (hadSnapshot && snapshotExists(newName)) renameSnapshot(newName, oldName);
        if (hadQueue && queueStorageExists(newName)) renameQueue(newName, oldName);
        if (sessionRenamed && hasSession(newSession)) renameSession(newSession, oldSession);
      } catch {
        // Preserve the original failure; recovery instructions are clearer
        // than replacing it with a secondary rollback error.
      }
    }
    throw error;
  } finally {
    releaseDeliverLock(oldName);
  }

  // A running provider still has its original name in its launch prompt and
  // environment. The alias keeps commands/hooks working immediately; this
  // notice teaches it the new canonical name on the next hook boundary.
  // Exited Codex sessions need the same notice because resume cannot append a
  // fresh system prompt (Claude can).
  if (live || agentProvider(agent) === "codex") {
    const notice = `[am] Your managed agent identity was renamed from "${oldName}" to "${newName}". Use the new name for am commands and peer messages. Your worktree and branch are unchanged.`;
    queueAppend(newName, notice);
  }

  return { oldName, newName, live, worktreeBranch: agent.worktreeBranch };
}

export async function renameCommand(prefix: string, newName: string): Promise<void> {
  const result = await renameAgent(prefix, newName);
  console.log(`renamed agent "${result.oldName}" → "${result.newName}"${result.live ? " without interrupting its session" : ""}`);
  if (result.worktreeBranch) console.log(`  worktree branch unchanged: ${result.worktreeBranch}`);
}
