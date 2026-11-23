import { call } from "./bridge";
import { $ } from "./dom";
import { parseAgentKey } from "./fleet";
import { checkNotificationSettings, NOTIFICATION_KINDS, PresenceWriter } from "./notificationPolicy";
import { changed, state, subscribe } from "./state";
import type { NotificationSettings, NotificationSettingsPatch } from "./types";

const loading = new Set<string>();
let editingConnection: string | null = null;

function result(text: string, tone: "" | "ok" | "error" = ""): void {
  const node = $("am-notifications-result");
  node.textContent = text;
  node.className = tone;
}

async function loadSettings(connection: string, showError = false): Promise<NotificationSettings | null> {
  if (loading.has(connection)) return state.notificationSettings.get(connection) ?? null;
  loading.add(connection);
  try {
    const response = await call("api.get", { connection, path: "/api/notifications/settings" });
    if (response.status < 200 || response.status >= 300) throw new Error(`Server returned HTTP ${response.status}`);
    const checked = checkNotificationSettings(response.body);
    if (!checked.ok) throw new Error(checked.error);
    state.notificationSettings.set(connection, checked.value);
    changed("fleet");
    return checked.value;
  } catch (error) {
    if (showError) result(error instanceof Error ? error.message : String(error), "error");
    return null;
  } finally {
    loading.delete(connection);
  }
}

function fill(settings: NotificationSettings): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-notification-kind]")) {
    input.checked = settings.enabled[input.dataset.notificationKind as keyof NotificationSettings["enabled"]];
  }
  ($<HTMLInputElement>("am-idle-min")).value = String(settings.idleMinSeconds / 60);
  ($<HTMLInputElement>("am-idle-cooldown")).value = String(settings.idleCooldownSeconds / 60);
  ($<HTMLInputElement>("am-idle-coalesce")).value = String(settings.idleCoalesceSeconds);
  ($<HTMLTextAreaElement>("am-muted-agents")).value = settings.mutedAgents.join("\n");
}

async function chooseConnection(connection: string): Promise<void> {
  editingConnection = connection;
  result("Loading…");
  const settings = state.notificationSettings.get(connection) ?? await loadSettings(connection, true);
  if (settings) { fill(settings); result(""); }
}

export function openNotificationSettings(): void {
  const select = $<HTMLSelectElement>("am-notifications-connection");
  select.replaceChildren(...[...state.conns.values()].map(({ conn }) => new Option(conn.name, conn.id)));
  const selected = state.selected ? parseAgentKey(state.selected)?.connection : null;
  const connection = selected && state.conns.has(selected) ? selected : state.conns.keys().next().value;
  if (!connection) return;
  select.value = connection;
  $("am-notification-settings").hidden = false;
  void chooseConnection(connection);
  $("am-notifications-close").focus();
}

function closeSettings(): void {
  $("am-notification-settings").hidden = true;
  $("am-sb-notifications").focus();
}

function number(id: string, scale: number): number {
  const value = Number($<HTMLInputElement>(id).value);
  if (!Number.isFinite(value) || value < 0) throw new Error("Timing values must be zero or greater");
  return Math.round(value * scale);
}

async function save(): Promise<void> {
  if (!editingConnection) return;
  const patch: NotificationSettingsPatch = {
    enabled: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind,
      document.querySelector<HTMLInputElement>(`[data-notification-kind="${kind}"]`)!.checked])),
    idleMinSeconds: number("am-idle-min", 60),
    idleCooldownSeconds: number("am-idle-cooldown", 60),
    idleCoalesceSeconds: number("am-idle-coalesce", 1),
    mutedAgents: $<HTMLTextAreaElement>("am-muted-agents").value.split(/[\s,]+/).filter(Boolean),
  };
  result("Saving…");
  const response = await call("notifications.settings", { connection: editingConnection, patch });
  if (response.status < 200 || response.status >= 300) throw new Error(`Server returned HTTP ${response.status}`);
  const checked = checkNotificationSettings(response.body);
  if (!checked.ok) throw new Error(checked.error);
  state.notificationSettings.set(editingConnection, checked.value);
  fill(checked.value);
  changed("fleet");
  result("Saved on this server", "ok");
}

const presence = new PresenceWriter((connection, value) => call("notifications.presence", { connection, ...value }));
let previousConnection: string | null = null;

function heartbeat(): void {
  const parsed = state.selected ? parseAgentKey(state.selected) : null;
  if (previousConnection && previousConnection !== parsed?.connection) presence.publish(previousConnection, { focused: false });
  previousConnection = parsed?.connection ?? null;
  if (!parsed || !state.conns.has(parsed.connection)) return;
  const focused = document.hasFocus() && !document.hidden;
  presence.publish(parsed.connection, { agent: parsed.id, focused });
}

export function initNotifications(): void {
  $("am-sb-notifications").addEventListener("click", openNotificationSettings);
  $("am-notifications-close").addEventListener("click", closeSettings);
  $<HTMLSelectElement>("am-notifications-connection").addEventListener("change", (event) => void chooseConnection((event.target as HTMLSelectElement).value));
  document.querySelector<HTMLFormElement>(".am-settings-card")!.addEventListener("submit", (event) => {
    event.preventDefault();
    void save().catch((error: unknown) => result(error instanceof Error ? error.message : String(error), "error"));
  });
  $("am-notification-settings").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeSettings(); });
  subscribe("fleet", () => {
    for (const id of state.conns.keys()) if (!state.notificationSettings.has(id)) void loadSettings(id);
  });
  subscribe("seen", heartbeat);
  window.addEventListener("focus", heartbeat);
  window.addEventListener("blur", heartbeat);
  document.addEventListener("visibilitychange", heartbeat);
  setInterval(heartbeat, 15_000);
}
