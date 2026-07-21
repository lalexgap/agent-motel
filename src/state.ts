import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentsDir, ensureDirs, lastAttachedFile } from "./paths";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";

export type AgentStatus =
  | "starting"
  | "idle"
  | "working"
  | "needs-attention"
  | "exited";

export type Provider = "claude" | "codex";

export interface AgentState {
  name: string;
  // Previous names kept as exact aliases after a rename. This preserves
  // peer replies, queued cross-machine mail, and old shell history without
  // making aliases participate in fuzzy prefix matching.
  aliases?: string[];
  status: AgentStatus;
  dir: string;
  tmuxSession: string;
  // Absent in state files written before multi-provider support → claude.
  provider?: Provider;
  // Set only for --worktree agents, so `am rm --clean` can remove the worktree.
  worktreePath?: string;
  worktreeBranch?: string;
  repoRoot?: string;
  // Conversation/session id, captured from hook payloads — lets `am resume`
  // reopen the exact conversation after the session exits.
  sessionId?: string;
  // Legacy name for sessionId; still read as a fallback.
  claudeSessionId?: string;
  // Codex reports the rollout file location in hook payloads; saved so
  // `am transcript` doesn't have to search ~/.codex/sessions for it.
  transcriptPath?: string;
  // The initial -m message: what this agent is for. Searchable in the picker.
  task?: string;
  // Set when a turn starts, used to measure the work stint for idle
  // notifications.
  workingSince?: string;
  // Standing report relationship: this agent keeps `reportTo` posted. Drives
  // the primer briefing and the Stop-hook backstop heads-up.
  reportTo?: string;
  // The agent that ran `am new` to create this one (AGENTMGR_AGENT at spawn).
  // Lets `--report` / a bare report target default to "whoever made me".
  spawnedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export function agentProvider(state: AgentState): Provider {
  return state.provider ?? "claude";
}

export function agentSessionId(state: AgentState): string | undefined {
  return state.sessionId ?? state.claudeSessionId;
}

function stateFile(name: string): string {
  return join(agentsDir(), `${name}.json`);
}

// Tolerant read: a torn/corrupt state file must not brick every am command
// (and every hook). But silence would make the agent invisibly unmanageable
// (unlisted, un-rm-able), so the damage is quarantined loudly: the file moves
// aside as .corrupt, freeing the name.
function readStateFile(file: string): AgentState | null {
  if (!existsSync(file)) return null;
  const state = readJsonOrNull<AgentState>(file);
  if (state === null) {
    try {
      renameSync(file, `${file}.corrupt`);
      console.error(`am: quarantined corrupt state file ${file} → ${file}.corrupt`);
    } catch {
      // raced another quarantiner (or the file vanished) — already handled
    }
  }
  return state;
}

export function readAgent(name: string): AgentState | null {
  return readStateFile(stateFile(name));
}

export function writeAgent(state: AgentState): void {
  ensureDirs();
  state.updatedAt = new Date().toISOString();
  // Atomic: state files are written by several processes at once (hooks, the
  // CLI, the daemon) and read constantly.
  writeJsonAtomic(stateFile(state.name), state);
}

export function setStatus(name: string, status: AgentStatus): void {
  const state = readAgent(name);
  if (!state) return;
  state.status = status;
  writeAgent(state);
}

export function removeAgent(name: string): void {
  rmSync(stateFile(name), { force: true });
}

export function listAgents(): AgentState[] {
  if (!existsSync(agentsDir())) return [];
  return readdirSync(agentsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => readStateFile(join(agentsDir(), f)))
    .filter((s): s is AgentState => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function agentNamesAndAliases(state: AgentState): string[] {
  return [state.name, ...(state.aliases ?? [])];
}

// Exact current names win over aliases. Aliases are deliberately exact-only:
// `am send old-name` should survive a rename, while a short prefix should keep
// resolving against the visible, current fleet rather than hidden history.
export function matchAgent(prefix: string): AgentState | null {
  const agents = listAgents();
  const exact = agents.find((agent) => agent.name === prefix);
  if (exact) return exact;

  const aliasMatches = agents.filter((agent) => agent.aliases?.includes(prefix));
  if (aliasMatches.length === 1) return aliasMatches[0]!;
  if (aliasMatches.length > 1) {
    throw new Error(`"${prefix}" is an alias for multiple agents: ${aliasMatches.map((a) => a.name).join(", ")}`);
  }

  const matches = agents.filter((agent) => agent.name.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`"${prefix}" is ambiguous: ${matches.map((a) => a.name).join(", ")}`);
  }
  return null;
}

export function agentNameOwner(name: string): AgentState | null {
  return listAgents().find((agent) => agent.name === name || agent.aliases?.includes(name)) ?? null;
}

// Exact match wins; otherwise the prefix must be unambiguous.
export function resolveAgentName(prefix: string, names: string[]): string {
  if (names.includes(prefix)) return prefix;
  const matches = names.filter((n) => n.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no agent matches "${prefix}"`);
  throw new Error(`"${prefix}" is ambiguous: ${matches.join(", ")}`);
}

export function resolveAgent(prefix: string): AgentState {
  if (listAgents().length === 0) throw new Error("no agents exist — create one with `am new <name>`");
  const agent = matchAgent(prefix);
  if (!agent) throw new Error(`no agent matches "${prefix}"`);
  return agent;
}

interface LastAttached {
  current?: string;
  previous?: string;
}

export function readLastAttached(): LastAttached {
  return readJsonOrNull<LastAttached>(lastAttachedFile()) ?? {};
}

export function recordAttached(name: string): void {
  ensureDirs();
  const last = readLastAttached();
  if (last.current === name) return;
  writeJsonAtomic(lastAttachedFile(), { current: name, previous: last.current });
}

export function renameLastAttached(oldName: string, newName: string): void {
  const last = readLastAttached();
  const next = {
    current: last.current === oldName ? newName : last.current,
    previous: last.previous === oldName ? newName : last.previous,
  };
  if (next.current !== last.current || next.previous !== last.previous) {
    writeJsonAtomic(lastAttachedFile(), next);
  }
}
