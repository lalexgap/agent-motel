// Agent actions without the DOM: which apply to an agent, the model dialog's
// choices, the move dialog's hosts, how a result reads, what to open
// afterwards and when a key must be released first. The rules follow the
// browser UI's (web/app.js); tests/desktopActions.test.ts compares them.
import { AGENT_GONE, CONFIRM_OPEN, isConfirmMethod, RUNNING_STATUSES } from "./policy";
import { TOKEN_REJECTED } from "./composer";
import type { AgentRow, ConfirmedResult, HostsResponse, RunningStatus } from "./types";

// A fleet row (no capabilities) or an agent detail (with them).
export type ActionSubject = Partial<Pick<AgentRow, "name" | "status" | "provider" | "role">> & { capabilities?: Record<string, unknown> };

// Capabilities an Antigravity agent lacks when the server does not say (fleet rows never do).
const NATIVE_CONTROLS = ["remoteControl", "quota", "approvalRelay", "interruptByReceipt", "handoff", "move", "rename", "subagents", "attachments"];

export function capabilityAvailable(row: ActionSubject | null | undefined, capability: string): boolean {
  if (row?.capabilities?.[capability] === false) return false;
  return row?.provider !== "antigravity" || !NATIVE_CONTROLS.includes(capability);
}

const roleName = (role: ActionSubject["role"]): unknown => (role && typeof role === "object" ? role.name : undefined) || role;

// `delete` is Remove. Anything not listed (open, move, delete) is always offered.
export function actionAvailable(row: ActionSubject | null | undefined, action: string): boolean {
  if (!row) return false;
  const capability = ({ handover: "handoff", interrupt: "interruptByReceipt", model: "restart" } as Record<string, string>)[action] || action;
  if (!capabilityAvailable(row, capability)) return false;
  const stopped = row.status === "dead" || row.status === "exited";
  if (action === "resume") return stopped;
  if (["stop", "restart", "model", "terminal"].includes(action)) return !stopped;
  if (action === "interrupt") return ["working", "waiting", "needs-attention"].includes(row.status ?? "");
  if (action === "rename") return row.name !== "concierge";
  if (action === "handover") {
    return row.provider !== "antigravity" && row.capabilities?.handoff !== false && roleName(row.role) !== "concierge" && row.name !== "concierge";
  }
  return true;
}

// Lifecycle actions and the bridge method each one calls.
export const LIFECYCLE = {
  resume: "agents.resume",
  restart: "agents.restart",
  interrupt: "agents.interrupt",
  stop: "agents.stop",
  delete: "agents.remove",
} as const;
export type LifecycleAction = keyof typeof LIFECYCLE;
export const LIFECYCLE_LABEL: Record<LifecycleAction, string> = {
  resume: "Resume", restart: "Restart", interrupt: "Interrupt", stop: "Stop", delete: "Remove…",
};

// GET /api/models.
export interface CatalogModel {
  id: string;
  label?: string;
  efforts?: string[];
}
export interface ProviderCatalog {
  provider: string;
  models?: CatalogModel[];
  efforts?: string[];
  modelsExhaustive?: boolean;
  effortsExhaustive?: boolean;
}
export interface Choice {
  value: string;
  label: string;
}

// The server answers with a bare array; the browser UI also takes `{catalogs}`.
export function pickCatalog(response: unknown, provider: string): ProviderCatalog | null {
  const list = Array.isArray(response) ? response : (response as { catalogs?: unknown } | null)?.catalogs;
  if (!Array.isArray(list)) return null;
  return (list as ProviderCatalog[]).find((catalog) => catalog?.provider === provider) ?? null;
}

export function modelChoices(catalog: ProviderCatalog | null | undefined, current: string | null | undefined): Choice[] {
  const choices: Choice[] = [{ value: "", label: "Provider default" }];
  for (const model of catalog?.models || []) choices.push({ value: model.id, label: model.label || model.id });
  if (current && !choices.some((choice) => choice.value === current) && catalog?.modelsExhaustive === false)
    choices.push({ value: current, label: current + " (configured)" });
  return choices;
}

export function effortChoices(catalog: ProviderCatalog | null | undefined, modelId: string, current: string | null | undefined): Choice[] {
  const model = catalog?.models?.find((candidate) => candidate.id === modelId);
  const efforts = model?.efforts?.length ? model.efforts : catalog?.efforts || [];
  const choices: Choice[] = [{ value: "", label: "Provider default" }, ...efforts.map((value) => ({ value, label: value }))];
  if (current && !choices.some((choice) => choice.value === current) && catalog?.effortsExhaustive === false)
    choices.push({ value: current, label: current + " (configured)" });
  return choices;
}

// What a select shows: the wanted value when it is a choice, else the first ("Provider default").
export const chosen = (choices: readonly Choice[], wanted: string | null | undefined): string =>
  wanted && choices.some((choice) => choice.value === wanted) ? wanted : "";

// A remote agent can only come back to this server; a local one can go to any
// configured host. Unlike the browser UI, unreachable hosts say so.
export interface HostOption extends Choice {
  unreachable: boolean;
}
export function moveHostOptions(hosts: Partial<HostsResponse> | null | undefined, remote: boolean): HostOption[] {
  if (remote) return [{ value: "local", label: `${hosts?.local || "This server"} (this server)`, unreachable: false }];
  return (Array.isArray(hosts?.hosts) ? hosts.hosts : [])
    .filter((host) => typeof host?.name === "string" && host.name)
    .map((host) => ({ value: host.name, label: host.reachable === false ? `${host.name} (unreachable)` : host.name, unreachable: host.reachable === false }));
}
export const NO_HOSTS = "No remote hosts configured.";

export const defaultHandoverTarget = (provider: string | undefined): "claude" | "codex" => (provider === "codex" ? "claude" : "codex");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// The bridge refuses the same; checking first keeps the error in the dialog's words.
export function nameProblem(name: string): string | null {
  if (!name) return "Enter a name.";
  if (!NAME_RE.test(name)) return "Use 1–64 letters, numbers, dashes or underscores.";
  if (name === "concierge") return "“concierge” is reserved for the fleet concierge.";
  return null;
}

// The move dialog's directory: optional, trimmed, absolute.
export function moveDir(text: string): { dir?: string } | { error: string } {
  const dir = text.trim();
  if (!dir) return {};
  if (!dir.startsWith("/") || /[\u0000-\u001f\u007f]/.test(dir)) return { error: "The destination directory must be an absolute path." };
  return { dir };
}

// The model change's precondition from a fresh detail: the same agent, still
// running, and the status am will compare, which is the displayed `status`
// (never `rawStatus`), as the browser UI sends it.
export const AGENT_REPLACED = "This agent was replaced since the dialog opened. Close the dialog and check the agent before retrying.";
export const AGENT_STOPPED = "This agent has stopped since the dialog opened. Resume it before changing the model.";
export function modelPrecondition(fresh: Pick<AgentRow, "createdAt" | "status" | "rawStatus">, createdAt: string): { status: RunningStatus } | { error: string } {
  if (fresh.createdAt !== createdAt) return { error: AGENT_REPLACED };
  if (!(RUNNING_STATUSES as readonly string[]).includes(fresh.status)) return { error: AGENT_STOPPED };
  return { status: fresh.status as RunningStatus };
}

export const AGENT_CHANGED = "Agent status changed. Refresh and try again.";
export const SERVER_FAILED = "The server could not complete that. Refresh and check the agent before retrying.";
export const UNREACHABLE = "Couldn't reach the server. Check the agent before retrying.";
export const SUFFIX = {
  manage: "Check the agent list before retrying if the connection was interrupted.",
  handover: "Check the agent list before retrying if the request was interrupted.",
  model: "Refresh and check the agent's configured model before retrying.",
} as const;

export type ActionOutcome =
  | { kind: "cancelled" }
  | { kind: "ok"; body: unknown }
  // `advised`: the message already says what to check, so no dialog suffix.
  | { kind: "failed"; message: string; gone?: boolean; tokenRejected?: boolean; advised?: boolean };

const serverError = (body: unknown): string | undefined => {
  const value = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
};

// `method`: the bridge method that answered. The bridge checks the agent exists
// before a stop's sheet, so a 404 from the stop itself is am's lifecycle-busy
// refusal ("being stopped, removed, renamed, or restarted — retry"): say that.
export function resultOutcome(result: ConfirmedResult, method?: string): ActionOutcome {
  if ((result as { cancelled?: unknown }).cancelled === true) return { kind: "cancelled" };
  const { status, body } = result as { status: number; body: unknown };
  if (status >= 200 && status < 300) return { kind: "ok", body };
  if (status === 401) return { kind: "failed", message: TOKEN_REJECTED, tokenRejected: true, advised: true };
  const text = serverError(body);
  if (status === 404) return { kind: "failed", message: method === "agents.stop" && text ? text : AGENT_GONE, gone: true, advised: true };
  // A 500 is am's opaque "request failed" (a lifecycle-busy remove, among others).
  if (status === 500 || (status > 500 && !text)) return { kind: "failed", message: SERVER_FAILED, advised: true };
  if (text) return { kind: "failed", message: text };
  return { kind: "failed", message: `The server returned HTTP ${status}.` };
}

// Bridge rejections that are the bridge's own answer: nothing was sent, or (the
// pre-check's 404) there was nothing to act on. Anything else is the network.
const BRIDGE_MESSAGES = [
  CONFIRM_OPEN, "Couldn't check the agent", "invalid ", "unknown connection:", "unknown method:", "params.",
  "This connection has no saved token", "This confirmation has expired", "The connection changed", "File is not a valid",
];
export function rejectionOutcome(error: unknown): ActionOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message === AGENT_GONE) return { kind: "failed", message: AGENT_GONE, gone: true, advised: true };
  if (BRIDGE_MESSAGES.some((prefix) => message.startsWith(prefix))) return { kind: "failed", message };
  return { kind: "failed", message: UNREACHABLE, advised: true };
}

// The text a dialog shows for a failure, with the browser UI's advice appended.
export const dialogMessage = (outcome: Extract<ActionOutcome, { kind: "failed" }>, suffix: string): string =>
  outcome.advised ? outcome.message : `${outcome.message.replace(/\s+$/, "")}${/[.!?]$/.test(outcome.message.trim()) ? "" : "."} ${suffix}`;

// The agent to open after a rename, move or handover succeeded: `key` (remote
// rename, move, handover) or the new `name` (local rename), on the same connection.
export function keyAfter(connection: string, action: "rename" | "move" | "handover", body: unknown): string | null {
  const fields = body && typeof body === "object" ? (body as { key?: unknown; name?: unknown }) : {};
  const id = typeof fields.key === "string" && fields.key ? fields.key : action === "rename" && typeof fields.name === "string" && fields.name ? fields.name : null;
  return id ? `${connection}/${id}` : null;
}

// After a remove: the overview when the removed agent was open, else no change.
export const selectionAfterRemove = (selected: string | null, removed: string): string | null | undefined =>
  selected === removed ? null : undefined;

// A key that activated a confirmed action and is still down must come up
// before the bridge raises its sheet, or the sheet's default button would take it.
export const ACTIVATION_KEYS = ["Enter", " "] as const;
export function keyToRelease(method: string, held: ReadonlySet<string>): string | null {
  if (!isConfirmMethod(method)) return null;
  return ACTIVATION_KEYS.find((key) => held.has(key)) ?? null;
}
