import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentsDir, ensureDirs, lastAttachedFile } from "./paths";

export type AgentStatus =
  | "starting"
  | "idle"
  | "working"
  | "needs-attention"
  | "exited";

export type Provider = "claude" | "codex";

export interface AgentState {
  name: string;
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

export function readAgent(name: string): AgentState | null {
  const file = stateFile(name);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as AgentState;
}

export function writeAgent(state: AgentState): void {
  ensureDirs();
  state.updatedAt = new Date().toISOString();
  writeFileSync(stateFile(state.name), JSON.stringify(state, null, 2) + "\n");
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
    .map((f) => JSON.parse(readFileSync(join(agentsDir(), f), "utf8")) as AgentState)
    .sort((a, b) => a.name.localeCompare(b.name));
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
  const names = listAgents().map((a) => a.name);
  if (names.length === 0) throw new Error("no agents exist — create one with `am new <name>`");
  const name = resolveAgentName(prefix, names);
  return readAgent(name)!;
}

interface LastAttached {
  current?: string;
  previous?: string;
}

export function readLastAttached(): LastAttached {
  if (!existsSync(lastAttachedFile())) return {};
  return JSON.parse(readFileSync(lastAttachedFile(), "utf8")) as LastAttached;
}

export function recordAttached(name: string): void {
  ensureDirs();
  const last = readLastAttached();
  if (last.current === name) return;
  writeFileSync(
    lastAttachedFile(),
    JSON.stringify({ current: name, previous: last.current }, null, 2) + "\n",
  );
}
