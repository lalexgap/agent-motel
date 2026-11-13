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
  subagents?: SubagentSummary;
  // The stored status where `status` is how the agent is shown: an agent idle
  // at its prompt with live subagents shows `working` here and `idle` there.
  rawStatus?: AgentStatus;
  // What an idle-at-prompt agent still waits on: absent on rows, null on the detail, when nothing.
  busyWith?: BusyWith | null;
  // "prompt": needs-attention for a provider dialog.
  statusKind?: "prompt" | null;
  // Questions the agent registered for the owner. Rows only, and only from an
  // am that reads decision stores (today, local agents); missing means none.
  openDecisions?: number;
  blockingDecisions?: number;
  oldestDecisionAt?: string;
  firstDecision?: string;
}

export interface BusyWith {
  subagents: number;
  background: number;
}

// The fleet row's rollup of the built-in subagents running under an agent.
// `running` is absent from a remote am that predates it.
export interface RunningSubagent {
  id: string;
  type?: string;
  description?: string;
  startedAt?: string;
}
export interface SubagentSummary {
  active?: number;
  types?: string;
  detail?: string;
  running?: RunningSubagent[];
}

// GET /api/agents/:key/subagents: `stale` marks a record still open when its
// agent is no longer running.
export interface SubagentTokens {
  steps?: number;
  inputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}
export interface SubagentRecord {
  id: string;
  type: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  message?: string;
  transcriptPath?: string;
  tokens?: SubagentTokens;
  stale?: boolean;
}
export interface SubagentsResponse {
  records: SubagentRecord[];
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

// A confirmed action the user declined: nothing was sent.
export interface Cancelled {
  cancelled: true;
}
export type ConfirmedResult = ApiResponse | Cancelled;
export const wasCancelled = (result: ConfirmedResult): result is Cancelled => (result as Cancelled).cancelled === true;

export type RunningStatus = "starting" | "idle" | "waiting" | "working" | "needs-attention";
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type DecisionAction = "answer" | "withdraw";

type AgentParams = { connection: string; agent: string };

export interface BridgeMethods {
  "app.info": { params: Record<string, never>; result: AppInfo };
  "connections.list": { params: Record<string, never>; result: Connection[] };
  "connections.test": { params: { url: string; token: string }; result: { ok: boolean; status: number; error?: string } };
  "connections.save": { params: { id?: string; name: string; url: string; token?: string }; result: Connection };
  "connections.remove": { params: { id: string }; result: Record<string, never> };
  "api.get": { params: { connection: string; path: string }; result: ApiResponse };
  // Fetches the secret capability URL natively and opens it without returning it to the page.
  "decisions.open": { params: AgentParams & { decisionId?: string }; result: Record<string, never> };
  "decisions.answer": { params: AgentParams & { id: string; action: DecisionAction; text: string }; result: ApiResponse };
  // Mutations take values; the bridge builds each path and body itself.
  "messages.send": { params: { connection: string; agent: string; text: string; mode: SendMode }; result: ApiResponse };
  "messages.cancel": { params: { connection: string; agent: string; id: string }; result: ApiResponse };
  "agents.resume": { params: AgentParams; result: ApiResponse };
  // Confirmed by the user (native alert, or window.confirm in browser dev mode) after an existence pre-check.
  "agents.restart": { params: AgentParams; result: ConfirmedResult };
  "agents.interrupt": { params: AgentParams; result: ConfirmedResult };
  "agents.stop": { params: AgentParams; result: ConfirmedResult };
  "agents.remove": { params: AgentParams; result: ConfirmedResult };
  "agents.rename": { params: AgentParams & { name: string }; result: ApiResponse };
  "agents.move": { params: AgentParams & { host: string; dir?: string }; result: ConfirmedResult };
  "agents.model": {
    params: AgentParams & { model: string | null; effort?: string | null; createdAt: string; status: RunningStatus };
    result: ConfirmedResult;
  };
  "agents.handoff": { params: AgentParams & { to: "claude" | "codex"; newName?: string; full?: boolean }; result: ApiResponse };
  "agents.create": {
    params: { connection: string; name: string; task: string; provider: Provider; dir?: string; host?: string; model?: string; effort?: string; role?: string };
    result: ApiResponse;
  };
  "permissions.answer": { params: AgentParams & { id: string; optionId: string }; result: ApiResponse };
  "prompt.answer": { params: AgentParams & { id: string; optionId: string; text?: string }; result: ApiResponse };
  // `data` is standard base64 of the image bytes (at most 10 MiB decoded).
  "files.upload": { params: AgentParams & { type: ImageType; data: string }; result: ApiResponse };
  "concierge.ensure": { params: { connection: string }; result: ApiResponse };
  "search.query": { params: { connection: string; query: string }; result: ApiResponse };
  "events.start": { params: { connection: string }; result: Record<string, never> };
  "events.stop": { params: { connection: string }; result: Record<string, never> };
  "open.external": { params: { url: string }; result: Record<string, never> };
  // Consent, sign-in, preflight and upgrade all happen inside the bridge. Resolves once the socket is open.
  "terminal.open": { params: { connection: string; agent: string }; result: TerminalOpened | Cancelled };
  "terminal.input": { params: { id: string; data: string }; result: Record<string, never> };
  "terminal.resize": { params: { id: string; cols: number; rows: number }; result: Record<string, never> };
  // Idempotent: an unknown id is a no-op.
  "terminal.close": { params: { id: string }; result: Record<string, never> };
}
export type BridgeMethod = keyof BridgeMethods;

export type TerminalTransport = "local" | "ssh";
export interface TerminalOpened {
  id: string;
  transport: TerminalTransport;
}
export type TerminalControl = { type: "ready" } | { type: "exit"; code: number } | { type: "error"; message: string };

// What the dev bridge returns for a confirmed action instead of sending it: the
// confirmation text and a one-time ticket that alone can release the request.
export interface DevConfirmation {
  ticket: string;
  title: string;
  body: string;
  button: string;
  defaultIsCancel: boolean;
  server: string;
  url: string;
}

export type StreamState = "connecting" | "open" | "closed";

export interface BridgeEvents {
  "events.state": { connection: string; state: StreamState; error?: string };
  "events.message": { connection: string; event: string; data: unknown };
  "menu.command": { command: "connections" | "find" | "reload" | "chat" | "terminal" };
  // `data` is base64 of raw output bytes, at most 64 KiB decoded per event.
  "terminal.output": { id: string; data: string };
  "terminal.control": { id: string; message: TerminalControl };
  // Exactly once per opened terminal. Local failures use code 1006.
  "terminal.closed": { id: string; code: number; reason: string };
}
export type BridgeEventName = keyof BridgeEvents;
