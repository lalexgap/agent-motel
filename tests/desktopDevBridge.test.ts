import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "../desktop/dev";
import { bridgeRequestAllowed, DevBridge } from "../desktop/devBridge";
import { FIXTURE_TOKEN, startFixtureServer, type FixtureServer } from "../desktop/fixtures/server";

const headers = (entries: Record<string, string>) => new Headers(entries);

describe("dev bridge origin check", () => {
  test("same-origin POST with a matching Origin is allowed", () => {
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", origin: "http://127.0.0.1:5199" }), 5199)).toBe(true);
    expect(bridgeRequestAllowed(headers({ host: "localhost:5199", origin: "http://localhost:5199" }), 5199)).toBe(true);
  });
  test("same-origin GET without Origin needs Sec-Fetch-Site", () => {
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", "sec-fetch-site": "same-origin" }), 5199)).toBe(true);
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199" }), 5199)).toBe(false);
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", "sec-fetch-site": "cross-site" }), 5199)).toBe(false);
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", "sec-fetch-site": "same-site" }), 5199)).toBe(false);
  });
  test("other origins, ports and rebinding hosts are refused", () => {
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", origin: "http://evil.example" }), 5199)).toBe(false);
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", origin: "http://127.0.0.1:3000" }), 5199)).toBe(false);
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", origin: "null" }), 5199)).toBe(false);
    expect(bridgeRequestAllowed(headers({ host: "evil.example:5199", origin: "http://evil.example:5199" }), 5199)).toBe(false);
    expect(bridgeRequestAllowed(headers({ host: "127.0.0.1:5199", origin: "http://localhost:5199" }), 5199)).toBe(false);
  });
});

describe("dev bridge methods", () => {
  let fixture: FixtureServer;
  let bridge: DevBridge;
  beforeAll(() => {
    fixture = startFixtureServer({ port: 0, flipMs: 60_000 });
    bridge = new DevBridge({ version: "0.0.0-test", build: "test" });
  });
  afterAll(() => {
    bridge.stopAll();
    fixture.stop();
  });

  test("app.info and unknown methods", async () => {
    expect(await bridge.handle("app.info", {})).toEqual({ version: "0.0.0-test", build: "test", platform: "macos" });
    await expect(bridge.handle("nope.nope", {})).rejects.toThrow("unknown method: nope.nope");
  });

  test("save validates and never returns the token", async () => {
    await expect(bridge.handle("connections.save", { name: "x", url: "http://192.168.1.5" })).rejects.toThrow(/Plain http/);
    await expect(bridge.handle("connections.save", { name: "x", url: fixture.url })).rejects.toThrow(/access token/);
    const saved = (await bridge.handle("connections.save", { name: "Fixture", url: fixture.url + "/", token: FIXTURE_TOKEN })) as { id: string };
    expect(saved as unknown).toEqual({ id: saved.id, name: "Fixture", url: fixture.url, hasToken: true });
    const list = await bridge.handle("connections.list", {});
    expect(JSON.stringify(list)).not.toContain(FIXTURE_TOKEN);
    // Editing without a token keeps the stored one.
    const renamed = await bridge.handle("connections.save", { id: saved.id, name: "Renamed", url: fixture.url });
    expect(renamed).toEqual({ id: saved.id, name: "Renamed", url: fixture.url, hasToken: true });
    const health = await bridge.handle("api.get", { connection: saved.id, path: "/api/health" });
    expect(health).toEqual({ status: 200, body: { ok: true, name: "am" } });
  });

  test("api.get enforces path rules and resolves HTTP errors", async () => {
    const { id } = (await bridge.handle("connections.save", { name: "F", url: fixture.url, token: FIXTURE_TOKEN })) as { id: string };
    for (const path of ["//evil.example/api/x", "/api/../x", "/etc/passwd", "/api/%2e%2e/x"])
      await expect(bridge.handle("api.get", { connection: id, path })).rejects.toThrow();
    expect(await bridge.handle("api.get", { connection: id, path: "/api/agents/nobody" })).toMatchObject({ status: 404 });
    await expect(bridge.handle("api.get", { connection: "missing", path: "/api/agents" })).rejects.toThrow(/unknown connection/);
    const bad = (await bridge.handle("connections.save", { name: "Bad", url: fixture.url, token: "wrong" })) as { id: string };
    expect(await bridge.handle("api.get", { connection: bad.id, path: "/api/agents" })).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  test("connections.test reports ok, 401 and network failure without storing", async () => {
    const before = ((await bridge.handle("connections.list", {})) as unknown[]).length;
    expect(await bridge.handle("connections.test", { url: fixture.url, token: FIXTURE_TOKEN })).toEqual({ ok: true, status: 200 });
    expect(await bridge.handle("connections.test", { url: fixture.url, token: "wrong" })).toEqual({ ok: false, status: 401, error: "unauthorized" });
    const down = (await bridge.handle("connections.test", { url: "http://127.0.0.1:9", token: "x" })) as { ok: boolean; status: number };
    expect(down).toMatchObject({ ok: false, status: 0 });
    await expect(bridge.handle("connections.test", { url: "http://192.168.1.5", token: "x" })).rejects.toThrow(/Plain http/);
    expect(((await bridge.handle("connections.list", {})) as unknown[]).length).toBe(before);
  });

  test("events.start relays state and SSE messages; remove stops the stream", async () => {
    const { id } = (await bridge.handle("connections.save", { name: "Live", url: fixture.url, token: FIXTURE_TOKEN })) as { id: string };
    const seen: { name: string; payload: { connection?: string; state?: string; event?: string } }[] = [];
    const unsubscribe = bridge.subscribe((name, payload) => seen.push({ name, payload: payload as never }));
    await bridge.handle("events.start", { connection: id });
    await bridge.handle("events.start", { connection: id });
    const deadline = Date.now() + 3000;
    while (!seen.some((event) => event.name === "events.message" && event.payload.event === "ready") && Date.now() < deadline) await Bun.sleep(20);
    const mine = seen.filter((event) => event.payload.connection === id);
    expect(mine.map((event) => event.payload.state ?? event.payload.event)).toEqual(["connecting", "open", "ready"]);
    await bridge.handle("connections.remove", { id });
    expect(((await bridge.handle("connections.list", {})) as { id: string }[]).some((conn) => conn.id === id)).toBe(false);
    unsubscribe();
  });

  test("open.external validates the URL", async () => {
    expect(await bridge.handle("open.external", { url: "https://example.com/x" })).toEqual({});
    await expect(bridge.handle("open.external", { url: "file:///etc/passwd" })).rejects.toThrow();
  });
});

describe("dev server", () => {
  let dir: string;
  let server: ReturnType<typeof startDevServer>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "am-desktop-dist-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
    server = startDevServer({ port: 0, bridge: new DevBridge({ version: "t", build: "t" }), root: dir });
  });
  afterAll(() => {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const host = () => `127.0.0.1:${server.port}`;

  test("serves dist with the CSP header", async () => {
    const response = await fetch(server.url + "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(server.url + "/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
  });

  test("/__bridge refuses cross-origin callers and accepts its own page", async () => {
    const body = JSON.stringify({ method: "connections.list", params: {} });
    const post = (extra: Record<string, string>) =>
      fetch(server.url + "/__bridge", { method: "POST", headers: { "content-type": "application/json", ...extra }, body });
    expect((await post({ origin: "http://evil.example" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    const ok = await post({ origin: `http://${host()}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: [] });
    expect((await fetch(server.url + "/__bridge/events", { headers: { origin: "http://evil.example" } })).status).toBe(403);
  });
});
