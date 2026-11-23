import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { setRemoteRunnersForTests } from "../src/remoteAgents";

let home: string;
let server: ApiServerHandle;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-notifications-api-"));
  process.env.AGENTMGR_HOME = home;
  server = startApiServer({ port: 0, hostname: "127.0.0.1", token: "notification-test" });
});
afterEach(() => {
  server.stop();
  setRemoteRunnersForTests();
  delete process.env.AGENTMGR_HOME;
  rmSync(home, { recursive: true, force: true });
});
const request = (path: string, body?: unknown) => fetch(`${server.url}/api/notifications/${path}`, {
  headers: { Authorization: "Bearer notification-test", "Content-Type": "application/json" },
  ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
});

test("settings are authenticated, persisted, and preserve unrelated config", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ hostAlias: "test", apiPort: 9999 }));
  expect((await fetch(`${server.url}/api/notifications/settings`)).status).toBe(401);
  const defaults = await (await request("settings")).json();
  expect(defaults).toMatchObject({ idleCooldownSeconds: 600 });
  const changed = await request("settings", { enabled: { idle: false }, mutedAgents: ["agent-one"] });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({ enabled: { idle: false, attention: true }, mutedAgents: ["agent-one"] });
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toMatchObject({ apiPort: 9999 });
  expect(await (await request("settings")).json()).toMatchObject({ enabled: { idle: false } });
});

test("invalid settings fail without partial updates", async () => {
  const before = await (await request("settings")).json();
  for (const body of [null, [], { notifyCommand: "anything" }, { idleCooldownSeconds: -1 },
    { enabled: { attention: "false" } }, { mutedAgents: ["../agent"] },
    { enabled: { idle: false }, idleMinSeconds: "10" }]) {
    expect((await request("settings", body)).status).toBe(400);
    expect(await (await request("settings")).json()).toEqual(before);
  }
});

test("presence validates target and fields before forwarding", async () => {
  for (const body of [null, { clientId: "tab", focused: true },
    { clientId: "../tab", focused: false }, { clientId: "tab", agent: "../bad", focused: true },
    { clientId: "tab", focused: false, command: "anything" }]) {
    expect((await request("presence", body)).status).toBe(400);
  }
  expect((await request("presence", { clientId: "tab", agent: "unknown:agent", focused: true })).status).toBe(404);
  expect((await request("presence", { clientId: "tab", agent: "agent", focused: true })).status).toBe(200);
  expect((await request("presence", { clientId: "tab", focused: false })).status).toBe(200);
});

test("remote selection forwards presence and clears old host when selection changes", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ hostAlias: "here", remotes: ["laptop"] }));
  const calls: { host: string; args: string[]; body: unknown }[] = [];
  setRemoteRunnersForTests({ am: async (host, args, opts) => {
    calls.push({ host, args, body: JSON.parse(opts?.stdin ?? "{}") });
    return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
  } });
  expect((await request("presence", { clientId: "remote-tab", agent: "laptop:agent", focused: true })).status).toBe(200);
  expect(calls[0]).toMatchObject({ host: "laptop", args: ["__notification-presence", "--local", "--exact"], body: { clientId: "here:remote-tab", agent: "agent", focused: true } });
  expect((await request("presence", { clientId: "remote-tab", agent: "local-agent", focused: true })).status).toBe(200);
  expect(calls[1]).toMatchObject({ host: "laptop", body: { focused: false } });
});
