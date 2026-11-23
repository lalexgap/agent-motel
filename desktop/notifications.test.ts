import { describe, expect, test } from "bun:test";
import { checkNotificationPatch, checkNotificationSettings, PresenceWriter } from "./src/notificationPolicy";
import { notificationSeconds } from "./src/notifications";
import { DevBridge } from "./devBridge";

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
