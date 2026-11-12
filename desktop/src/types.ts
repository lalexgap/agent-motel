// Shapes shared by the page, the dev bridge and the fixture server. Mirrors the
// bridge contract and the subset of the am HTTP API the app uses.
import type { SendMode } from "./policy";
export type { SendMode };

export interface Connection {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
}

export type AgentStatus = "starting" | "idle" | "working" | "waiting" | "needs-attention" | "exited" | "dead";
export type Provider = "claude" | "codex" | "antigravity";

export interface AgentRow {
  name: string;
  host?: string;
  status: AgentStatus;
  statusChangedAt: string;
  statusReason?: string;
  statusDetail?: string;
  provider: Provider;
  model?: string;
  effort?: string;
  role?: string | { name?: string };
  dir: string;
  repoRoot?: string;
  worktreeBranch?: string;
  task?: string;
  queued?: number;
  createdAt: string;
  updatedAt: string;
  workingSince?: string;
  spawnedBy?: string;
  prMonitor?: { pullRequests?: { number: number; state: string }[] };
  subagents?: { running?: RunningSubagent[] };
}

export interface RunningSubagent {
  id: string;
  type?: string;
  description?: string;
}

export interface QueueItem {
  msgId?: string;
  text?: string;
  message?: string;
  queuedAt?: string;
}

export interface AgentDetail extends AgentRow {
  queue: QueueItem[];
  pane: string;
  pendingPermissions: number;
  capabilities: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

export type TranscriptEntry =
  | { index: number; kind: "user" | "assistant"; text: string }
  | { index: number; kind: "tool"; name: string; input: string; output: string; error?: boolean };

export interface Transcript {
  provider: string;
  sessionId: string | null;
  status: string;
  total: number;
  entries: TranscriptEntry[];
}

export interface HostsResponse {
  local: string;
  hosts: { name: string; reachable: boolean }[];
}

export interface AgentsResponse {
  rows: AgentRow[];
  unreachable: string[];
}

export interface AppInfo {
  version: string;
  build: string;
  platform: "macos";
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface BridgeMethods {
  "app.info": { params: Record<string, never>; result: AppInfo };
  "connections.list": { params: Record<string, never>; result: Connection[] };
  "connections.test": { params: { url: string; token: string }; result: { ok: boolean; status: number; error?: string } };
  "connections.save": { params: { id?: string; name: string; url: string; token?: string }; result: Connection };
  "connections.remove": { params: { id: string }; result: Record<string, never> };
  "api.get": { params: { connection: string; path: string }; result: ApiResponse };
  // The only two mutations. The bridge builds the path from `agent` (and `id`).
  "messages.send": { params: { connection: string; agent: string; text: string; mode: SendMode }; result: ApiResponse };
  "messages.cancel": { params: { connection: string; agent: string; id: string }; result: ApiResponse };
  "events.start": { params: { connection: string }; result: Record<string, never> };
  "events.stop": { params: { connection: string }; result: Record<string, never> };
  "open.external": { params: { url: string }; result: Record<string, never> };
}
export type BridgeMethod = keyof BridgeMethods;

export type StreamState = "connecting" | "open" | "closed";

export interface BridgeEvents {
  "events.state": { connection: string; state: StreamState; error?: string };
  "events.message": { connection: string; event: string; data: unknown };
  "menu.command": { command: "connections" | "find" | "reload" };
}
export type BridgeEventName = keyof BridgeEvents;
