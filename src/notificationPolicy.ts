import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getNotificationSettings, type NotificationSettings } from "./config";
import { withFileLock } from "./filelock";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { type NotificationKind } from "./notifications";
import { baseDir } from "./paths";
import { queueDepth } from "./queue";
import { activeSubagents } from "./subagents";
import { listAgents, type AgentState } from "./state";
import { hasAttachedClient } from "./tmux";

export { getNotificationSettings, setAgentMuted, updateNotificationSettings } from "./config";

const PRESENCE_TTL_MS = 45_000;
const MAX_PRESENCE_CLIENTS = 64;
const MAX_PENDING = 256;
const MAX_TRACKED_AGENTS = 512;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const STALE_AFTER_DUE_MS = 10 * 60_000;

export interface NotificationPresence {
  clientId: string;
  agent?: string;
  focused: boolean;
  at: string;
}

interface PendingIdle {
  agent: string;
  workedSeconds: number;
  createdAt: string;
  dueAt: string;
  startedAt: string;
  statusChangedAt?: string;
  sessionId?: string;
}

interface PolicyAuditEntry {
  at: string;
  event: "queued" | "sent" | "discarded" | "presence" | "activity";
  agent?: string;
  reason?: IdlePolicyReason;
  kind?: NotificationKind;
  clientId?: string;
  focused?: boolean;
}

interface PolicyState {
  version: 1;
  pending: PendingIdle[];
  lastIdleAt: Record<string, string>;
  recentActivityAt: Record<string, string>;
}

export type IdlePolicyReason =
  | "disabled"
  | "concierge"
  | "muted"
  | "focused"
  | "attached"
  | "short-stint"
  | "queued-message"
  | "recent-activity"
  | "cooldown"
  | "working-again"
  | "running-subagents"
  | "stale"
  | "missing-agent";

export interface IdlePolicyInput {
  agent: string;
  role?: string;
  status?: AgentState["status"];
  workedSeconds: number;
  queueDepth?: number;
  attached?: boolean;
  focused?: boolean;
  runningSubagents?: number;
  recentActivityAt?: number;
  lastIdleAt?: number;
  createdAt?: number;
  dueAt?: number;
  settings: NotificationSettings;
  now: number;
  flushing?: boolean;
}

export interface IdleNotification {
  title: string;
  message: string;
  meta: { kind: "idle"; agent?: string };
}

function policyFile(): string {
  return join(baseDir(), "notification-policy.json");
}

function policyLock(): string {
  return join(baseDir(), "notification-policy.lock");
}

function policyAuditFile(): string {
  return join(baseDir(), "notification-policy-audit.jsonl");
}

function presenceFile(): string {
  return join(baseDir(), "notification-presence.json");
}

function presenceLock(): string {
  return join(baseDir(), "notification-presence.lock");
}

function nowMs(value: number | Date = Date.now()): number {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result)) throw new Error("invalid timestamp");
  return result;
}

function emptyState(): PolicyState {
  return { version: 1, pending: [], lastIdleAt: {}, recentActivityAt: {} };
}

function readPolicyState(): PolicyState {
  const state = readJsonOrNull<PolicyState>(policyFile());
  if (state?.version !== 1 || !Array.isArray(state.pending)) return emptyState();
  return {
    version: 1,
    pending: state.pending.slice(-MAX_PENDING),
    lastIdleAt: state.lastIdleAt && typeof state.lastIdleAt === "object" ? state.lastIdleAt : {},
    recentActivityAt: state.recentActivityAt && typeof state.recentActivityAt === "object" ? state.recentActivityAt : {},
  };
}

// Called while policyLock is held. The journal contains only policy metadata,
// never notification or conversation bodies.
function appendAudit(entry: PolicyAuditEntry): void {
  try {
    const file = policyAuditFile();
    appendFileSync(file, JSON.stringify(entry) + "\n");
    if (statSync(file).size <= MAX_AUDIT_BYTES) return;
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    let bytes = 0;
    let start = lines.length;
    while (start > 0) {
      const size = Buffer.byteLength(lines[start - 1]!) + 1;
      if (bytes + size > MAX_AUDIT_BYTES / 2) break;
      bytes += size;
      start -= 1;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.slice(start).join("\n") + "\n");
    renameSync(tmp, file);
  } catch {
    // Audit history is best-effort; it must not block notification delivery.
  }
}

function trimMap(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values)
    .filter(([, at]) => Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, MAX_TRACKED_AGENTS));
}

function writePolicyState(state: PolicyState): void {
  state.pending = state.pending.slice(-MAX_PENDING);
  state.lastIdleAt = trimMap(state.lastIdleAt);
  state.recentActivityAt = trimMap(state.recentActivityAt);
  writeJsonAtomic(policyFile(), state);
}

function validatePresence(value: unknown): Omit<NotificationPresence, "at"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("notification presence must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["clientId", "agent", "focused"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unknown notification presence field: ${key}`);
  if (typeof input.clientId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.clientId)) {
    throw new Error("notification presence clientId must be 1-128 safe characters");
  }
  if (input.agent !== undefined && (typeof input.agent !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.agent))) {
    throw new Error("notification presence agent must be a bounded local agent name");
  }
  if (typeof input.focused !== "boolean") throw new Error("notification presence focused must be boolean");
  return { clientId: input.clientId, ...(input.agent ? { agent: input.agent } : {}), focused: input.focused };
}

function readPresence(now: number): NotificationPresence[] {
  const records = readJsonOrNull<NotificationPresence[]>(presenceFile());
  if (!Array.isArray(records)) return [];
  return records.filter((record) =>
    typeof record?.clientId === "string" &&
    typeof record.focused === "boolean" &&
    Number.isFinite(Date.parse(record.at)) &&
    now - Date.parse(record.at) <= PRESENCE_TTL_MS
  ).slice(-MAX_PRESENCE_CLIENTS);
}

export function recordNotificationPresence(value: unknown, now: number | Date = Date.now()): NotificationPresence {
  const input = validatePresence(value);
  const at = nowMs(now);
  const record: NotificationPresence = { ...input, at: new Date(at).toISOString() };
  withFileLock(presenceLock(), () => {
    const records = readPresence(at).filter((item) => item.clientId !== record.clientId);
    records.push(record);
    writeJsonAtomic(presenceFile(), records.slice(-MAX_PRESENCE_CLIENTS));
  });
  withFileLock(policyLock(), () => {
    appendAudit({ at: record.at, event: "presence", clientId: record.clientId, agent: record.agent, focused: record.focused });
  });
  return record;
}

export function focusedNotificationAgents(now: number | Date = Date.now()): Set<string> {
  const at = nowMs(now);
  return new Set(readPresence(at).filter((record) => record.focused && record.agent).map((record) => record.agent!));
}

export function idleSuppressionReason(input: IdlePolicyInput): IdlePolicyReason | null {
  const { settings, now } = input;
  if (!settings.enabled.idle) return "disabled";
  if (input.agent === "concierge" || input.role === "concierge") return "concierge";
  if (settings.mutedAgents.includes(input.agent)) return "muted";
  if (input.focused) return "focused";
  if (input.attached) return "attached";
  if (input.queueDepth && input.queueDepth > 0) return "queued-message";
  if (!Number.isFinite(input.workedSeconds) || input.workedSeconds < settings.idleMinSeconds) return "short-stint";
  const activityBoundary = input.createdAt ?? now;
  if (input.recentActivityAt !== undefined &&
      input.recentActivityAt >= activityBoundary - settings.idleCoalesceSeconds * 1000) return "recent-activity";
  if (input.lastIdleAt !== undefined && now - input.lastIdleAt < settings.idleCooldownSeconds * 1000) return "cooldown";
  if (input.flushing) {
    if (input.status !== "idle") return "working-again";
    if ((input.runningSubagents ?? 0) > 0) return "running-subagents";
    if (input.dueAt !== undefined && now > input.dueAt + STALE_AFTER_DUE_MS) return "stale";
  }
  return null;
}

export function recordNotificationActivity(agent: string | undefined, kind: NotificationKind, now: number | Date = Date.now()): void {
  if (!agent || (kind !== "decision" && kind !== "pr" && kind !== "share")) return;
  const at = new Date(nowMs(now)).toISOString();
  withFileLock(policyLock(), () => {
    const state = readPolicyState();
    state.recentActivityAt[agent] = at;
    appendAudit({ at, event: "activity", agent, kind });
    writePolicyState(state);
  });
}

export function queueIdleNotification(
  input: { agent: AgentState; workedSeconds: number; queueDepth?: number; attached?: boolean; runningSubagents?: number },
  now: number | Date = Date.now(),
): { queued: boolean; dueAt?: string; reason?: IdlePolicyReason } {
  const at = nowMs(now);
  return withFileLock(policyLock(), () => {
    const state = readPolicyState();
    const settings = getNotificationSettings();
    const recentActivityAt = Date.parse(state.recentActivityAt[input.agent.name] ?? "");
    const lastIdleAt = Date.parse(state.lastIdleAt[input.agent.name] ?? "");
    const reason = idleSuppressionReason({
      agent: input.agent.name,
      role: input.agent.role,
      status: input.agent.status,
      workedSeconds: input.workedSeconds,
      queueDepth: input.queueDepth,
      attached: input.attached,
      focused: focusedNotificationAgents(at).has(input.agent.name),
      runningSubagents: input.runningSubagents,
      recentActivityAt: Number.isFinite(recentActivityAt) ? recentActivityAt : undefined,
      lastIdleAt: Number.isFinite(lastIdleAt) ? lastIdleAt : undefined,
      settings,
      now: at,
    });
    state.pending = state.pending.filter((pending) => pending.agent !== input.agent.name);
    if (reason) {
      appendAudit({ at: new Date(at).toISOString(), event: "discarded", agent: input.agent.name, reason });
      writePolicyState(state);
      return { queued: false, reason };
    }
    const sharedDueAt = state.pending
      .map((item) => Date.parse(item.dueAt))
      .filter((value) => Number.isFinite(value) && value > at)
      .sort((a, b) => a - b)[0];
    const pending: PendingIdle = {
      agent: input.agent.name,
      workedSeconds: input.workedSeconds,
      createdAt: new Date(at).toISOString(),
      dueAt: new Date(sharedDueAt ?? at + settings.idleCoalesceSeconds * 1000).toISOString(),
      startedAt: new Date(at - input.workedSeconds * 1000).toISOString(),
      statusChangedAt: input.agent.statusChangedAt,
      sessionId: input.agent.sessionId,
    };
    state.pending.push(pending);
    appendAudit({ at: pending.createdAt, event: "queued", agent: input.agent.name });
    writePolicyState(state);
    return { queued: true, dueAt: pending.dueAt };
  });
}

function agentByName(): Map<string, AgentState> {
  return new Map(listAgents().map((agent) => [agent.name, agent]));
}

export function flushIdleNotifications(now: number | Date = Date.now()): IdleNotification[] {
  const at = nowMs(now);
  if (!existsSync(policyFile()) || readPolicyState().pending.length === 0) return [];
  const settings = getNotificationSettings();
  const focused = focusedNotificationAgents(at);
  const agents = agentByName();
  const due: PendingIdle[] = [];
  withFileLock(policyLock(), () => {
    const state = readPolicyState();
    const waiting: PendingIdle[] = [];
    for (const pending of state.pending) {
      const dueAt = Date.parse(pending.dueAt);
      if (!Number.isFinite(dueAt) || dueAt > at) {
        waiting.push(pending);
        continue;
      }
      const agent = agents.get(pending.agent);
      let reason: IdlePolicyReason | null = agent ? null : "missing-agent";
      if (agent) {
        const recent = Date.parse(state.recentActivityAt[pending.agent] ?? "");
        const lastIdle = Date.parse(state.lastIdleAt[pending.agent] ?? "");
        if (agent.statusChangedAt !== pending.statusChangedAt || agent.sessionId !== pending.sessionId) reason = "working-again";
        else reason = idleSuppressionReason({
          agent: pending.agent,
          role: agent.role,
          status: agent.status,
          workedSeconds: pending.workedSeconds,
          queueDepth: queueDepth(pending.agent),
          attached: hasAttachedClient(agent.tmuxSession),
          focused: focused.has(pending.agent),
          runningSubagents: activeSubagents(pending.agent).length,
          recentActivityAt: Number.isFinite(recent) ? recent : undefined,
          lastIdleAt: Number.isFinite(lastIdle) ? lastIdle : undefined,
          createdAt: Date.parse(pending.createdAt),
          dueAt,
          settings,
          now: at,
          flushing: true,
        });
      }
      if (reason) {
        appendAudit({ at: new Date(at).toISOString(), event: "discarded", agent: pending.agent, reason });
        continue;
      }
      due.push(pending);
      state.lastIdleAt[pending.agent] = new Date(at).toISOString();
      appendAudit({ at: new Date(at).toISOString(), event: "sent", agent: pending.agent });
    }
    state.pending = waiting;
    writePolicyState(state);
  });
  if (due.length === 0) return [];
  const names = due.map((pending) => pending.agent).sort();
  if (due.length === 1) {
    const pending = due[0]!;
    return [{
      title: `am: ${pending.agent}`,
      message: `finished — idle after ${formatDuration(pending.workedSeconds)}`,
      meta: { agent: pending.agent, kind: "idle" },
    }];
  }
  return [{
    title: "am: agents idle",
    message: `${names.length} agents finished — idle: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}`,
    meta: { kind: "idle" },
  }];
}

export function pendingIdleCount(): number {
  return existsSync(policyFile()) ? readPolicyState().pending.length : 0;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}
