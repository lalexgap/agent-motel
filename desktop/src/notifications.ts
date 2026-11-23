import { call } from "./bridge";
import { $ } from "./dom";
import { parseAgentKey } from "./fleet";
import { checkNotificationSettings, NOTIFICATION_KINDS, PresenceWriter } from "./notificationPolicy";
import { changed, state, subscribe } from "./state";
import { NotificationSettingsController } from "./notificationSettings";
import type { ApiResponse, NotificationSettings } from "./types";

const settingsController = new NotificationSettingsController(
  async (connection) => settingsResponse(await call("api.get", { connection, path: "/api/notifications/settings" })),
  async (connection, patch) => settingsResponse(await call("notifications.settings", { connection, patch })),
  (connection, settings) => { state.notificationSettings.set(connection, settings); changed("fleet"); },
  (view) => {
    if (view.settings) fill(view.settings);
    $<HTMLButtonElement>("am-notifications-save").disabled = !view.canSave;
    result(view.message, view.tone);
  },
);

function result(text: string, tone: "" | "ok" | "error" = ""): void {
  const node = $("am-notifications-result");
  node.textContent = text;
  node.className = tone;
}

function settingsResponse(response: ApiResponse): NotificationSettings {
  if (response.status < 200 || response.status >= 300) throw new Error(`Server returned HTTP ${response.status}`);
  const checked = checkNotificationSettings(response.body);
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
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

export function openNotificationSettings(): void {
  const select = $<HTMLSelectElement>("am-notifications-connection");
  select.replaceChildren(...[...state.conns.values()].map(({ conn }) => new Option(conn.name, conn.id)));
  const selected = state.selected ? parseAgentKey(state.selected)?.connection : null;
  const connection = selected && state.conns.has(selected) ? selected : state.conns.keys().next().value;
  if (!connection) return;
  select.value = connection;
  $("am-notification-settings").hidden = false;
  void settingsController.select(connection);
  $("am-notifications-close").focus();
}

function closeSettings(): void {
  settingsController.close();
  $("am-notification-settings").hidden = true;
  $("am-sb-notifications").focus();
}

export function notificationSeconds(value: string, scale: number): number {
  const seconds = Number(value) * scale;
  const rounded = Math.round(seconds);
  if (!value.trim() || !Number.isFinite(seconds) || seconds < 0 || rounded > 86_400 || Math.abs(seconds - rounded) > 1e-6) {
    throw new Error("Timing values must be whole seconds from 0 to 86400");
  }
  return rounded;
}

function number(id: string, scale: number): number {
  return notificationSeconds($<HTMLInputElement>(id).value, scale);
}

async function save(): Promise<void> {
  await settingsController.save(() => ({
    enabled: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind,
      document.querySelector<HTMLInputElement>(`[data-notification-kind="${kind}"]`)!.checked])),
    idleMinSeconds: number("am-idle-min", 60),
    idleCooldownSeconds: number("am-idle-cooldown", 60),
    idleCoalesceSeconds: number("am-idle-coalesce", 1),
    mutedAgents: $<HTMLTextAreaElement>("am-muted-agents").value.split(/[\s,]+/).filter(Boolean),
  }));
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
  $<HTMLButtonElement>("am-notifications-save").disabled = true;
  $("am-sb-notifications").addEventListener("click", openNotificationSettings);
  $("am-notifications-close").addEventListener("click", closeSettings);
  $<HTMLSelectElement>("am-notifications-connection").addEventListener("change", (event) => void settingsController.select((event.target as HTMLSelectElement).value));
  document.querySelector<HTMLFormElement>(".am-settings-card")!.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  $("am-notification-settings").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeSettings(); });
  subscribe("fleet", () => {
    for (const id of state.conns.keys()) if (!state.notificationSettings.has(id)) void settingsController.load(id).catch(() => {});
  });
  subscribe("seen", heartbeat);
  window.addEventListener("focus", heartbeat);
  window.addEventListener("blur", heartbeat);
  document.addEventListener("visibilitychange", heartbeat);
  setInterval(heartbeat, 15_000);
}
