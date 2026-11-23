import { checkAgent, type Checked } from "./policy";
import type { NotificationSettings, NotificationSettingsPatch } from "./types";

export const NOTIFICATION_KINDS = ["attention", "idle", "share", "pr", "decision"] as const;
const MAX_SECONDS = 7 * 24 * 60 * 60;

const integer = (value: unknown, name: string): Checked<number> =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SECONDS
    ? { ok: true, value }
    : { ok: false, error: `${name} must be an integer from 0 to ${MAX_SECONDS}` };

export function checkNotificationSettings(value: unknown): Checked<NotificationSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid notification settings" };
  const raw = value as Record<string, unknown>;
  const enabled = raw.enabled;
  if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) return { ok: false, error: "invalid enabled settings" };
  const flags = enabled as Record<string, unknown>;
  if (Object.keys(flags).some((key) => !NOTIFICATION_KINDS.includes(key as never)) ||
      NOTIFICATION_KINDS.some((kind) => typeof flags[kind] !== "boolean")) return { ok: false, error: "invalid enabled settings" };
  const min = integer(raw.idleMinSeconds, "idleMinSeconds");
  const cooldown = integer(raw.idleCooldownSeconds, "idleCooldownSeconds");
  const coalesce = integer(raw.idleCoalesceSeconds, "idleCoalesceSeconds");
  if (!min.ok) return min;
  if (!cooldown.ok) return cooldown;
  if (!coalesce.ok) return coalesce;
  if (!Array.isArray(raw.mutedAgents) || raw.mutedAgents.length > 500) return { ok: false, error: "invalid mutedAgents" };
  const mutedAgents: string[] = [];
  for (const value of raw.mutedAgents) {
    const agent = checkAgent(value);
    if (!agent.ok) return { ok: false, error: "invalid mutedAgents" };
    if (!mutedAgents.includes(agent.value)) mutedAgents.push(agent.value);
  }
  return { ok: true, value: {
    enabled: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, flags[kind]])) as NotificationSettings["enabled"],
    idleMinSeconds: min.value, idleCooldownSeconds: cooldown.value, idleCoalesceSeconds: coalesce.value, mutedAgents,
  } };
}

export function checkNotificationPatch(value: unknown): Checked<NotificationSettingsPatch> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "patch must be an object" };
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["enabled", "idleMinSeconds", "idleCooldownSeconds", "idleCoalesceSeconds", "mutedAgents"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, error: "unknown notification setting" };
  const patch: NotificationSettingsPatch = {};
  if (raw.enabled !== undefined) {
    if (!raw.enabled || typeof raw.enabled !== "object" || Array.isArray(raw.enabled)) return { ok: false, error: "enabled must be an object" };
    const flags = raw.enabled as Record<string, unknown>;
    if (Object.keys(flags).some((key) => !NOTIFICATION_KINDS.includes(key as never) || typeof flags[key] !== "boolean"))
      return { ok: false, error: "invalid enabled patch" };
    patch.enabled = { ...flags };
  }
  for (const key of ["idleMinSeconds", "idleCooldownSeconds", "idleCoalesceSeconds"] as const) {
    if (raw[key] === undefined) continue;
    const checked = integer(raw[key], key);
    if (!checked.ok) return checked;
    patch[key] = checked.value;
  }
  if (raw.mutedAgents !== undefined) {
    if (!Array.isArray(raw.mutedAgents) || raw.mutedAgents.length > 500) return { ok: false, error: "invalid mutedAgents" };
    const values: string[] = [];
    for (const rawAgent of raw.mutedAgents) {
      const agent = checkAgent(rawAgent);
      if (!agent.ok) return { ok: false, error: "invalid mutedAgents" };
      if (!values.includes(agent.value)) values.push(agent.value);
    }
    patch.mutedAgents = values;
  }
  return { ok: true, value: patch };
}

export interface NotificationPresence { agent?: string; focused: boolean }
interface PresenceQueue { desired: NotificationPresence; revision: number; running: boolean }

/// One in-flight write per connection. Changes coalesce behind it, then the latest state is sent,
/// so an old focus heartbeat can never arrive after a newer blur or selection.
export class PresenceWriter {
  private queues = new Map<string, PresenceQueue>();
  constructor(private readonly send: (connection: string, presence: NotificationPresence) => Promise<unknown>) {}

  publish(connection: string, desired: NotificationPresence): void {
    let queue = this.queues.get(connection);
    if (!queue) {
      queue = { desired, revision: 0, running: false };
      this.queues.set(connection, queue);
    }
    queue.desired = desired;
    queue.revision++;
    if (!queue.running) void this.drain(connection, queue);
  }

  private async drain(connection: string, queue: PresenceQueue): Promise<void> {
    queue.running = true;
    while (true) {
      const revision = queue.revision;
      const desired = queue.desired;
      try { await this.send(connection, desired); }
      catch (error) { console.warn("notification presence failed", error); }
      if (revision === queue.revision) break;
    }
    queue.running = false;
  }
}
