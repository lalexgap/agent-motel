import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_CSP, startDevServer } from "../desktop/dev";
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
    const nullId = await bridge.handle("connections.save", { id: null, name: "Null id", url: fixture.url, token: FIXTURE_TOKEN });
    expect(nullId).toMatchObject({ name: "Null id", hasToken: true });
  });

  test("save matches the app's name and token rules", async () => {
    const save = (params: Record<string, unknown>) => bridge.handle("connections.save", { name: "x", url: fixture.url, ...params });
    await expect(save({ name: "n".repeat(201), token: FIXTURE_TOKEN })).rejects.toThrow("The name must be 1 to 200 characters");
    expect(await save({ name: "n".repeat(200), token: FIXTURE_TOKEN })).toMatchObject({ hasToken: true });
    for (const token of [" padded ", "has space", "tab\t", "é"])
      await expect(save({ token })).rejects.toThrow("The access token must be printable ASCII without spaces");
    await expect(save({ id: "missing", token: FIXTURE_TOKEN })).rejects.toThrow(/unknown connection/);
  });

  test("changing the URL of a saved connection needs the token again", async () => {
    const saved = (await bridge.handle("connections.save", { name: "Move", url: fixture.url, token: FIXTURE_TOKEN })) as { id: string };
    await expect(bridge.handle("connections.save", { id: saved.id, name: "Move", url: "https://am.example.com" }))
      .rejects.toThrow("Enter the token again when changing the server URL");
    const list = (await bridge.handle("connections.list", {})) as { id: string; url: string }[];
    expect(list.find((conn) => conn.id === saved.id)?.url).toBe(fixture.url);
    expect(await bridge.handle("connections.save", { id: saved.id, name: "Move", url: "https://am.example.com", token: "new-token" }))
      .toEqual({ id: saved.id, name: "Move", url: "https://am.example.com", hasToken: true });
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
    expect(await bridge.handle("connections.test", { url: fixture.url, token: "wrong" })).toEqual({ ok: false, status: 401, error: "The server rejected the token" });
    const down = (await bridge.handle("connections.test", { url: "http://127.0.0.1:9", token: "x" })) as { ok: boolean; status: number };
    expect(down).toMatchObject({ ok: false, status: 0 });
    expect(await bridge.handle("connections.test", { url: "http://192.168.1.5", token: "x" })).toMatchObject({ ok: false, status: 0, error: expect.stringMatching(/Plain http/) });
    expect(await bridge.handle("connections.test", { url: fixture.url, token: "has space" })).toMatchObject({ ok: false, status: 0 });
    expect(((await bridge.handle("connections.list", {})) as unknown[]).length).toBe(before);
  });

  test("connections.test needs an Agent Motel health body, not just a 200", async () => {
    const stub = (async () => Response.json({ status: "fine" })) as unknown as typeof fetch;
    const other = new DevBridge({ version: "t", build: "t" }, stub);
    expect(await other.handle("connections.test", { url: "https://am.example.com", token: "x" }))
      .toEqual({ ok: false, status: 200, error: "This server did not answer like Agent Motel" });
  });

  test("connections.remove rejects an unknown id", async () => {
    await expect(bridge.handle("connections.remove", { id: "missing" })).rejects.toThrow(/unknown connection/);
  });

  test("an event that never ends is cut off at the size cap", async () => {
    const line = new TextEncoder().encode(`data: ${"a".repeat(1 << 20)}\n`);
    let sent = 0;
    const stub = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(line);
        else controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const capped = new DevBridge({ version: "t", build: "t" }, stub);
    const conn = capped.addConnection("Capped", "https://am.example.com", "x");
    const states: { state?: string; error?: string }[] = [];
    capped.subscribe((name, payload) => { if (name === "events.state") states.push(payload as never); });
    await capped.handle("events.start", { connection: conn.id });
    const deadline = Date.now() + 3000;
    while (!states.some((s) => s.state === "closed") && Date.now() < deadline) await Bun.sleep(10);
    capped.stopAll();
    expect(states.find((s) => s.state === "closed")?.error).toBe("The event stream sent an oversized event");
    expect(sent).toBeLessThan(20);
  });

  test("events.start relays state and SSE messages; remove stops the stream", async () => {
    const { id } = (await bridge.handle("connections.save", { name: "Live", url: fixture.url, token: FIXTURE_TOKEN })) as { id: string };
    const seen: { name: string; payload: { connection?: string; state?: string; event?: string } }[] = [];
    const unsubscribe = bridge.subscribe((name, payload) => seen.push({ name, payload: payload as never }));
    await bridge.handle("events.start", { connection: id });
    const deadline = Date.now() + 3000;
    while (!seen.some((event) => event.name === "events.message" && event.payload.event === "ready") && Date.now() < deadline) await Bun.sleep(20);
    // A second start on a running stream re-emits its current state, as the app does.
    await bridge.handle("events.start", { connection: id });
    const mine = seen.filter((event) => event.payload.connection === id);
    expect(mine.map((event) => event.payload.state ?? event.payload.event)).toEqual(["connecting", "open", "ready", "open"]);
    await bridge.handle("connections.remove", { id });
    expect(((await bridge.handle("connections.list", {})) as { id: string }[]).some((conn) => conn.id === id)).toBe(false);
    unsubscribe();
  });

  test("open.external validates the URL", async () => {
    expect(await bridge.handle("open.external", { url: "https://example.com/x" })).toEqual({});
    await expect(bridge.handle("open.external", { url: "file:///etc/passwd" })).rejects.toThrow();
  });
});

test("DEV_CSP is the app's CSP except connect-src", () => {
  const swift = readFileSync(join(import.meta.dir, "../macos/Sources/BundleResource.swift"), "utf8");
  const appCsp = swift.match(/"Content-Security-Policy": "([^"]+)"/)?.[1];
  expect(appCsp).toBeTruthy();
  expect(DEV_CSP).toBe(appCsp!.replace("connect-src 'none'", "connect-src 'self'"));
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
    expect(response.headers.get("content-security-policy")).toBe(DEV_CSP);
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
