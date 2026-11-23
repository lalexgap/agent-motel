import { describe, expect, test } from "bun:test";
import { checkNotificationPatch, checkNotificationSettings, PresenceWriter } from "./src/notificationPolicy";
import { notificationSeconds } from "./src/notifications";
import { DevBridge } from "./devBridge";
import { NotificationSettingsController, type SettingsView } from "./src/notificationSettings";
import type { NotificationSettings, NotificationSettingsPatch } from "./src/types";

const settings = {
  enabled: { attention: true, idle: true, share: false, pr: true, decision: true },
  idleMinSeconds: 120, idleCooldownSeconds: 600, idleCoalesceSeconds: 60,
  mutedAgents: ["local-agent", "remote-agent"],
};

describe("notification settings validation", () => {
  test("accepts the server shape and strict partial patches", () => {
    expect(checkNotificationSettings(settings)).toEqual({ ok: true, value: settings });
    expect(checkNotificationPatch({ enabled: { idle: false }, mutedAgents: ["x", "x"] }))
      .toEqual({ ok: true, value: { enabled: { idle: false }, mutedAgents: ["x"] } });
  });

  test("round-trips every integer-second timing through minute inputs", () => {
    expect(notificationSeconds(String(1 / 60), 60)).toBe(1);
    expect(notificationSeconds(String(86_400 / 60), 60)).toBe(86_400);
    expect(() => notificationSeconds(String(86_401 / 60), 60)).toThrow("0 to 86400");
    expect(() => notificationSeconds("0.01", 60)).toThrow("whole seconds");
    expect(() => notificationSeconds("", 60)).toThrow();
    expect(() => notificationSeconds("  ", 1)).toThrow();
  });

  test("rejects unknown keys, types, bounds and unsafe agents", () => {
    for (const patch of [
      { surprise: true }, { enabled: { other: true } }, { enabled: { idle: 1 } },
      { idleMinSeconds: -1 }, { idleCooldownSeconds: 1.5 }, { idleCoalesceSeconds: 86_401 },
      { mutedAgents: ["../agent"] }, { mutedAgents: ["host:agent"] },
      { mutedAgents: Array.from({ length: 257 }, (_, index) => `agent-${index}`) },
    ]) expect(checkNotificationPatch(patch).ok).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function controllerFixture() {
  const reads: { connection: string; request: ReturnType<typeof deferred<NotificationSettings>> }[] = [];
  const writes: { connection: string; patch: NotificationSettingsPatch; request: ReturnType<typeof deferred<NotificationSettings>> }[] = [];
  const cache = new Map<string, NotificationSettings>();
  const views: SettingsView[] = [];
  const controller = new NotificationSettingsController(
    (connection) => { const request = deferred<NotificationSettings>(); reads.push({ connection, request }); return request.promise; },
    (connection, patch) => { const request = deferred<NotificationSettings>(); writes.push({ connection, patch, request }); return request.promise; },
    (connection, value) => { cache.set(connection, value); },
    (view) => { views.push(view); },
  );
  return { controller, reads, writes, cache, views, view: () => views.at(-1)! };
}

test("late A load cannot replace selected B; startup load is joined and selection refreshes cache", async () => {
  const f = controllerFixture();
  const startup = f.controller.load("A");
  expect(f.controller.load("A")).toBe(startup);
  const a = f.controller.select("A");
  await flush();
  expect(f.reads).toHaveLength(1);
  await f.controller.save(() => settings);
  expect(f.writes).toHaveLength(0);
  const b = f.controller.select("B");
  await flush();
  const other = { ...settings, idleMinSeconds: 300 };
  f.reads[1]!.request.resolve(other);
  await b;
  f.reads[0]!.request.resolve(settings);
  await a;
  expect(f.view()).toMatchObject({ settings: other, canSave: true });
  const again = f.controller.select("B");
  await flush();
  expect(f.reads).toHaveLength(3);
  expect(f.view().canSave).toBe(false);
  f.reads[2]!.request.reject(new Error("offline"));
  await again;
  expect(f.view()).toMatchObject({ canSave: false, message: "offline" });
  await f.controller.save(() => settings);
  expect(f.writes).toHaveLength(0);
});

test("save snapshots A, rejects duplicates and owns A cache after selecting B", async () => {
  const f = controllerFixture();
  const a = f.controller.select("A");
  await flush(); f.reads[0]!.request.resolve(settings); await a;
  const saved = { ...settings, idleCooldownSeconds: 900 };
  const save = f.controller.save(() => saved);
  await f.controller.save(() => { throw new Error("must not read a second form"); });
  const b = f.controller.select("B");
  expect(f.view().canSave).toBe(false);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({ connection: "A", patch: saved });
  f.writes[0]!.request.resolve(saved);
  await save; await flush();
  expect(f.cache.get("A")).toEqual(saved);
  expect(f.cache.has("B")).toBe(false);
  expect(f.view().message).toBe("Loading…");
  f.reads[1]!.request.resolve(settings); await b;
  expect(f.view()).toMatchObject({ settings, canSave: true });
});

test("close/reopen invalidates load and save UI responses, including errors", async () => {
  const f = controllerFixture();
  const a = f.controller.select("A"); await flush();
  f.controller.close();
  const b = f.controller.select("B"); await flush();
  f.reads[0]!.request.reject(new Error("old failure")); await a;
  expect(f.view().message).toBe("Loading…");
  f.reads[1]!.request.resolve(settings); await b;
  const save = f.controller.save(() => settings);
  f.controller.close();
  const reopened = f.controller.select("B");
  f.writes[0]!.request.reject(new Error("old save failure"));
  await save; await flush();
  expect(f.view().message).toBe("Loading…");
  f.reads[2]!.request.resolve(settings); await reopened;
  expect(f.view()).toMatchObject({ settings, canSave: true, message: "" });
});

test("older background read cannot overwrite saved cache; new reads wait for save", async () => {
  const f = controllerFixture();
  const selected = f.controller.select("A"); await flush();
  f.reads[0]!.request.resolve(settings); await selected;
  const old = f.controller.load("A"); await flush();
  const saved = { ...settings, idleMinSeconds: 700 };
  const save = f.controller.save(() => saved);
  const fresh = f.controller.load("A"); await flush();
  expect(f.reads).toHaveLength(2);
  f.writes[0]!.request.resolve(saved); await save; await flush();
  f.reads[1]!.request.resolve(settings); await old;
  expect(f.cache.get("A")).toEqual(saved);
  f.reads[2]!.request.resolve(saved); await fresh;
  expect(f.view()).toMatchObject({ settings: saved, canSave: true });
});

test("reopening joins startup load but only the new session renders; save failure disables saving", async () => {
  const f = controllerFixture();
  const startup = f.controller.load("A");
  const first = f.controller.select("A");
  f.controller.close();
  const reopened = f.controller.select("A");
  await flush();
  expect(f.reads).toHaveLength(1);
  f.reads[0]!.request.resolve(settings);
  await Promise.all([startup, first, reopened]);
  expect(f.views.filter((view) => view.settings)).toHaveLength(1);
  expect(f.view()).toMatchObject({ settings, canSave: true });
  const save = f.controller.save(() => settings);
  f.writes[0]!.request.reject(new Error("write failed"));
  await save;
  expect(f.view()).toMatchObject({ canSave: false, message: "write failed" });
  await f.controller.save(() => settings);
  expect(f.writes).toHaveLength(1);
});

test("presence writes serialize and coalesce to the latest state", async () => {
  const releases: (() => void)[] = [];
  const sent: unknown[] = [];
  const writer = new PresenceWriter((_connection, value) => new Promise<void>((resolve) => { sent.push(value); releases.push(resolve); }));
  writer.publish("a", { agent: "old", focused: true });
  writer.publish("a", { agent: "new", focused: true });
  writer.publish("a", { focused: false });
  expect(sent).toEqual([{ agent: "old", focused: true }]);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toEqual([{ agent: "old", focused: true }, { focused: false }]);
  releases.shift()!();
});

test("dev bridge exposes only fixed notification writes with validated bodies", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    return Response.json(url.endsWith("/settings") ? settings : { ok: true });
  }) as typeof fetch;
  const bridge = new DevBridge({ version: "test", build: "test" }, fetcher);
  const connection = bridge.addConnection("Fixture", "https://am.example.test", "token");
  const response = await bridge.handle("notifications.settings", { connection: connection.id, patch: { enabled: { idle: false } } });
  expect(response).toEqual({ status: 200, body: settings });
  expect(requests[0]).toMatchObject({ url: "https://am.example.test/api/notifications/settings", init: {
    method: "POST", body: JSON.stringify({ enabled: { idle: false } }), redirect: "manual",
  } });
  await bridge.handle("notifications.presence", { connection: connection.id, agent: "host.example:agent", focused: true });
  const presence = JSON.parse(String(requests[1]!.init!.body));
  expect(requests[1]!.url).toBe("https://am.example.test/api/notifications/presence");
  expect(presence).toMatchObject({ agent: "host.example:agent", focused: true });
  expect(presence.clientId).toMatch(/^desktop-[A-Za-z0-9-]{36}$/);
  const before = requests.length;
  await expect(bridge.handle("notifications.settings", { connection: connection.id, patch: { route: "/api/other" } }))
    .rejects.toThrow("unknown notification setting");
  await expect(bridge.handle("notifications.presence", { connection: connection.id, focused: true }))
    .rejects.toThrow("focused presence requires an agent");
  expect(requests).toHaveLength(before);
});
