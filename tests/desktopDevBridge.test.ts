import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_BODY_MAX, DEV_CSP, startDevServer } from "../desktop/dev";
import { bridgeRequestAllowed, DevBridge, MUTATION_TIMEOUT_MS } from "../desktop/devBridge";
import { call } from "../desktop/src/bridge";
import { FIXTURE_TOKEN, FLOOD_BYTES, floodLine, startFixtureServer, type FixtureServer } from "../desktop/fixtures/server";

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

describe("dev bridge messages", () => {
  let fixture: FixtureServer;
  let bridge: DevBridge;
  let id: string;
  beforeAll(async () => {
    fixture = startFixtureServer({ port: 0, flipMs: 60_000, deliverMs: 50, replyMs: 50 });
    bridge = new DevBridge({ version: "t", build: "t" });
    id = ((await bridge.handle("connections.save", { name: "F", url: fixture.url, token: FIXTURE_TOKEN })) as { id: string }).id;
  });
  afterAll(() => {
    bridge.stopAll();
    fixture.stop();
  });
  const send = (params: Record<string, unknown>) => bridge.handle("messages.send", { connection: id, agent: "keeper-log", text: "hi", mode: "queue", ...params });

  test("validation rejects before anything is sent", async () => {
    const before = fixture.requests.length;
    await expect(send({ agent: "a/b" })).rejects.toThrow("invalid agent: a/b");
    await expect(send({ agent: "a:b:c" })).rejects.toThrow("invalid agent: a:b:c");
    await expect(send({ text: "  \n " })).rejects.toThrow("Message is empty");
    await expect(send({ text: "a".repeat(100_001) })).rejects.toThrow("Message is too long (limit 100,000 bytes)");
    await expect(send({ text: 42 })).rejects.toThrow();
    for (const text of ["stop\u001b", "\u0003", "x\u007f", "x\u009b"]) await expect(send({ text })).rejects.toThrow("Message contains a control character");
    for (const mode of ["interrupt", "Now", "", "queue ", 1]) await expect(send({ mode })).rejects.toThrow("mode must be queue or now");
    await expect(send({ connection: "missing" })).rejects.toThrow("unknown connection: missing");
    await expect(bridge.handle("messages.cancel", { connection: id, agent: "keeper-log", id: "a/b" })).rejects.toThrow();
    await expect(bridge.handle("messages.cancel", { connection: id, agent: "../x", id: "01A" })).rejects.toThrow("invalid agent: ../x");
    expect(fixture.requests.length).toBe(before);
  });

  test("send posts exactly {text, mode}, trimmed, to the fixed path", async () => {
    const before = fixture.requests.length;
    const result = (await send({ agent: "annex:kelp-forest", text: "  line one\n  line two \n", mode: "now" })) as { status: number; body: { ok: boolean; mode: string; id: string } };
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, mode: "now" });
    expect(result.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(fixture.requests.slice(before)).toEqual([
      { method: "POST", path: "/api/agents/annex%3Akelp-forest/messages", body: { text: "line one\n  line two", mode: "now" } },
    ]);
    const detail = (await bridge.handle("api.get", { connection: id, path: "/api/agents/annex%3Akelp-forest" })) as { body: { queue: unknown[] } };
    expect(detail.body.queue).toEqual([]);
  });

  test("HTTP errors resolve with status and body", async () => {
    expect(await send({ agent: "nobody" })).toMatchObject({ status: 404 });
    expect(await send({ agent: "old-lens" })).toMatchObject({ status: 409, body: { reason: "no_session" } });
  });

  test("cancel sends DELETE without a body", async () => {
    const queued = (await send({ agent: "harbor-lights", text: "later", mode: "queue" })) as { body: { id: string } };
    const detail = (await bridge.handle("api.get", { connection: id, path: "/api/agents/harbor-lights" })) as { body: { queue: { msgId?: string; message?: string }[] } };
    expect(detail.body.queue.filter((item) => item.message === "later")).toEqual([{ message: "later", queuedAt: expect.any(String) }]);
    const before = fixture.requests.length;
    expect(await bridge.handle("messages.cancel", { connection: id, agent: "harbor-lights", id: queued.body.id }))
      .toEqual({ status: 200, body: { ok: true, state: "cancelled" } });
    expect(fixture.requests.slice(before)).toEqual([{ method: "DELETE", path: `/api/agents/harbor-lights/messages/${queued.body.id}`, body: null }]);
  });

  test("bearer added by the bridge, redirects returned not followed, failures not retried", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stub = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/messages")) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const other = new DevBridge({ version: "t", build: "t" }, stub);
    const conn = other.addConnection("Stub", "https://am.example.com", "secret-token");
    expect(await other.handle("messages.send", { connection: conn.id, agent: "harbor-lights", text: "x", mode: "queue" })).toEqual({ status: 302, body: null });
    await expect(other.handle("messages.cancel", { connection: conn.id, agent: "harbor-lights", id: "01A" })).rejects.toThrow("network down");
    expect(calls).toHaveLength(2);
    const [post, del] = calls;
    expect(post!.url).toBe("https://am.example.com/api/agents/harbor-lights/messages");
    expect(post!.init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({ text: "x", mode: "queue" }) });
    expect(new Headers(post!.init.headers).get("authorization")).toBe("Bearer secret-token");
    expect(new Headers(post!.init.headers).get("content-type")).toBe("application/json");
    expect(del!.url).toBe("https://am.example.com/api/agents/harbor-lights/messages/01A");
    expect(del!.init).toMatchObject({ method: "DELETE", redirect: "manual" });
    expect(del!.init.body).toBeUndefined();
    expect(post!.init.signal).toBeInstanceOf(AbortSignal);
    expect(MUTATION_TIMEOUT_MS).toBe(60_000);
  });

  test("there is no generic mutation method", async () => {
    for (const method of ["api.post", "api.delete", "api.request", "messages.interrupt"])
      await expect(bridge.handle(method, { connection: id, path: "/api/agents/keeper-log/messages" })).rejects.toThrow(`unknown method: ${method}`);
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

// Agent actions, against an in-test stub am server on loopback that
// records every request exactly as it arrives.
interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
  bytes: number[] | null;
}
function startStub() {
  const requests: Seen[] = [];
  // Exact-name detail responses for the pre-check, by encoded key.
  const detail = new Map<string, Response | (() => Response | Promise<Response>)>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const raw = new Uint8Array(await req.arrayBuffer());
      const contentType = req.headers.get("content-type");
      const binary = contentType?.startsWith("image/") ?? false;
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        authorization: req.headers.get("authorization"),
        contentType,
        body: binary || !raw.length ? null : new TextDecoder().decode(raw),
        bytes: binary ? [...raw] : null,
      });
      if (req.method === "GET") {
        const key = url.pathname.replace(/^\/api\/agents\//, "");
        const canned = detail.get(key);
        if (canned) return typeof canned === "function" ? canned() : canned.clone();
        return Response.json({ name: decodeURIComponent(key), status: "working" });
      }
      return Response.json({ ok: true, echo: req.method }, { status: req.method === "POST" && url.pathname === "/api/agents" ? 201 : 200 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, detail, stop: () => server.stop(true) };
}

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const PROMPT_ID = "0123456789abcdef0123456789abcdef";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Records the timeout each request is given; the real AbortSignal is still returned.
function recordTimeouts(): { seen: number[]; restore: () => void } {
  const original = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    seen.push(ms);
    return original.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  return { seen, restore: () => { AbortSignal.timeout = original; } };
}

describe("dev bridge actions", () => {
  let stub: ReturnType<typeof startStub>;
  let bridge: DevBridge;
  let id: string;
  beforeAll(() => {
    stub = startStub();
    bridge = new DevBridge({ version: "t", build: "t" });
    id = bridge.addConnection("Stub motel", stub.url, "stub-token").id;
  });
  afterAll(() => {
    bridge.stopAll();
    stub.stop();
  });
  const since = (before: number) => stub.requests.slice(before);
  const json = (method: string, path: string, body: unknown): Seen => ({
    method,
    path,
    authorization: "Bearer stub-token",
    contentType: "application/json",
    body: JSON.stringify(body),
    bytes: null,
  });

  test("unconfirmed methods send exactly one request with the contract's path, body and timeout", async () => {
    const DIRECT: [method: string, params: Record<string, unknown>, expected: Seen, timeout: number][] = [
      ["agents.resume", { agent: "harbor-lights" }, json("POST", "/api/agents/harbor-lights/resume", {}), 60_000],
      ["agents.rename", { agent: "annex:kelp-forest", name: "kelp-bed" }, json("POST", "/api/agents/annex%3Akelp-forest/rename", { name: "kelp-bed" }), 60_000],
      ["agents.handoff", { agent: "harbor-lights", to: "codex", newName: "harbor-codex", full: true }, json("POST", "/api/agents/harbor-lights/handoff", { to: "codex", newName: "harbor-codex", full: true }), 150_000],
      ["agents.create", { name: "tide-tables", task: "  Chart the tides\n", provider: "codex", dir: "/srv/tides", host: "annex", model: "gpt-5", effort: "high", role: "engineer", inPlace: true, codex: true },
        json("POST", "/api/agents", { name: "tide-tables", task: "Chart the tides", provider: "codex", remoteDir: "/srv/tides", host: "annex", model: "gpt-5", effort: "high", role: "engineer" }), 150_000],
      ["agents.create", { name: "tide-tables", task: "x", provider: "claude", dir: "~/tides", host: "local" }, json("POST", "/api/agents", { name: "tide-tables", task: "x", provider: "claude", dir: "~/tides" }), 150_000],
      ["permissions.answer", { agent: "fog-signal", id: ULID, optionId: "accept" }, json("POST", `/api/agents/fog-signal/permissions/${ULID}`, { optionId: "accept" }), 45_000],
      ["prompt.answer", { agent: "origami-docs", id: PROMPT_ID, optionId: "4", text: " other answer " }, json("POST", "/api/agents/origami-docs/prompt", { id: PROMPT_ID, optionId: "4", text: " other answer " }), 45_000],
      ["concierge.ensure", {}, json("POST", "/api/concierge", {}), 120_000],
      ["search.query", { query: " harbor " }, json("POST", "/api/search", { query: "harbor" }), 30_000],
    ];
    for (const [method, params, expected, timeout] of DIRECT) {
      const before = stub.requests.length;
      const timeouts = recordTimeouts();
      let result: unknown;
      try {
        result = await bridge.handle(method, { connection: id, ...params });
      } finally {
        timeouts.restore();
      }
      expect(result).toEqual({ status: method === "agents.create" ? 201 : 200, body: { ok: true, echo: "POST" } });
      expect(since(before)).toEqual([expected]);
      expect(timeouts.seen).toEqual([timeout]);
    }
  });

  test("files.upload decodes base64 and sends the raw bytes with the image type", async () => {
    const before = stub.requests.length;
    const timeouts = recordTimeouts();
    try {
      expect(await bridge.handle("files.upload", { connection: id, agent: "harbor-lights", type: "image/png", data: Buffer.from(PNG).toString("base64") }))
        .toEqual({ status: 200, body: { ok: true, echo: "POST" } });
    } finally {
      timeouts.restore();
    }
    expect(since(before)).toEqual([{ method: "POST", path: "/api/agents/harbor-lights/files", authorization: "Bearer stub-token", contentType: "image/png", body: null, bytes: PNG }]);
    expect(timeouts.seen).toEqual([120_000]);
    await expect(bridge.handle("files.upload", { connection: id, agent: "harbor-lights", type: "image/jpeg", data: Buffer.from(PNG).toString("base64") }))
      .rejects.toThrow("File is not a valid image/jpeg image");
    expect(stub.requests.length).toBe(before + 1);
  });

  const CONFIRMED: [method: string, params: Record<string, unknown>, title: string, body: string, defaultIsCancel: boolean, request: Seen, timeout: number][] = [
    ["agents.restart", { agent: "harbor-lights" }, "Restart harbor-lights?", "This interrupts its current turn and reopens the conversation. Status: working.", false,
      json("POST", "/api/agents/harbor-lights/restart", {}), 60_000],
    ["agents.interrupt", { agent: "harbor-lights", text: "never sent" }, "Interrupt harbor-lights?", "This interrupts its current work. Status: working.", false,
      json("POST", "/api/agents/harbor-lights/interrupt", {}), 60_000],
    ["agents.stop", { agent: "annex:kelp-forest" }, "Stop annex:kelp-forest?", "This interrupts its current work and ends its session. It can be resumed later. Status: working.", false,
      json("POST", "/api/agents/annex%3Akelp-forest/stop", {}), 60_000],
    ["agents.remove", { agent: "harbor-lights" }, "Remove harbor-lights?", "Its session will stop and the agent will be removed, along with its queued messages. The worktree is kept. Status: working.", true,
      { method: "DELETE", path: "/api/agents/harbor-lights", authorization: "Bearer stub-token", contentType: null, body: null, bytes: null }, 60_000],
    ["agents.move", { agent: "harbor-lights", host: "annex", dir: "/srv/harbor" }, "Move harbor-lights to annex?", "The source will stop; workspace files are not copied. Status: working.", false,
      json("POST", "/api/agents/harbor-lights/move", { host: "annex", dir: "/srv/harbor" }), 600_000],
    ["agents.model", { agent: "harbor-lights", model: null, effort: "high", createdAt: "2026-11-01T09:00:00.000Z", status: "working" }, "Change the model for harbor-lights?",
      "This restarts the agent and interrupts its current turn. The conversation and queued messages are kept. Status: working.", false,
      json("POST", "/api/agents/harbor-lights/model", { model: null, effort: "high", createdAt: "2026-11-01T09:00:00.000Z", status: "working" }), 120_000],
  ];

  test("confirmed methods: pre-check only, then a re-check and the stored request once per accepted ticket", async () => {
    for (const [method, params, title, body, defaultIsCancel, expected, timeout] of CONFIRMED) {
      const before = stub.requests.length;
      const timeouts = recordTimeouts();
      try {
        const pending = (await bridge.handle(method, { connection: id, ...params })) as { confirm: { ticket: string } };
        expect(pending as unknown).toEqual({ confirm: { ticket: expect.any(String), title, body, button: expect.any(String), defaultIsCancel, server: "Stub motel", url: stub.url } });
        const key = expected.path.split("/")[3];
        const lookup = { method: "GET", path: `/api/agents/${key}`, authorization: "Bearer stub-token", contentType: null, body: null, bytes: null };
        // Nothing but the exact-name detail GET until the ticket is redeemed.
        expect(since(before)).toEqual([lookup]);
        expect(await bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).toEqual({ status: 200, body: { ok: true, echo: expected.method } });
        expect(since(before + 1)).toEqual([lookup, expected]);
        await expect(bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).rejects.toThrow("This confirmation has expired or was already answered");
        expect(stub.requests.length).toBe(before + 3);
      } finally {
        timeouts.restore();
      }
      expect(timeouts.seen).toEqual([15_000, 15_000, timeout]);
    }
  });

  test("an agent removed between the confirmation and the answer is not acted on", async () => {
    for (const method of ["agents.restart", "agents.interrupt", "agents.stop", "agents.remove"]) {
      stub.detail.delete("fading-cove");
      const pending = (await bridge.handle(method, { connection: id, agent: "fading-cove" })) as { confirm: { ticket: string } };
      stub.detail.set("fading-cove", new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
      const before = stub.requests.length;
      await expect(bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).rejects.toThrow("This agent no longer exists");
      expect(since(before).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/agents/fading-cove"]);
    }
    const pending = (await bridge.handle("agents.stop", { connection: id, agent: "ailing-cove" })) as { confirm: { ticket: string } };
    stub.detail.set("ailing-cove", new Response(JSON.stringify({ error: "request failed" }), { status: 500 }));
    const before = stub.requests.length;
    await expect(bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).rejects.toThrow("Couldn't check the agent (HTTP 500)");
    expect(since(before).every((r) => r.method === "GET")).toBe(true);
    stub.detail.delete("fading-cove");
    stub.detail.delete("ailing-cove");
  });

  test("the pre-check reports the agent's current status", async () => {
    stub.detail.set("quiet-cove", Response.json({ name: "quiet-cove", status: "needs-attention" }));
    stub.detail.set("odd-cove", Response.json({ name: "odd-cove" }));
    const quiet = (await bridge.handle("agents.stop", { connection: id, agent: "quiet-cove" })) as { confirm: { body: string } };
    expect(quiet.confirm.body).toEndWith("Status: needs-attention.");
    const odd = (await bridge.handle("agents.stop", { connection: id, agent: "odd-cove" })) as { confirm: { body: string } };
    expect(odd.confirm.body).toEndWith("Status: unknown.");
  });

  test("a declined, unknown or malformed ticket sends nothing", async () => {
    const pending = (await bridge.handle("agents.remove", { connection: id, agent: "harbor-lights" })) as { confirm: { ticket: string } };
    const before = stub.requests.length;
    expect(await bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: false })).toEqual({ cancelled: true });
    for (const params of [{ ticket: pending.confirm.ticket, accept: true }, { ticket: "made-up", accept: true }, { accept: true }, { ticket: 7, accept: true }])
      await expect(bridge.handle("dev.confirm", params)).rejects.toThrow("This confirmation has expired or was already answered");
    // Only a literal `true` accepts.
    const other = (await bridge.handle("agents.stop", { connection: id, agent: "harbor-lights" })) as { confirm: { ticket: string } };
    expect(await bridge.handle("dev.confirm", { ticket: other.confirm.ticket, accept: "yes" })).toEqual({ cancelled: true });
    expect(since(before).filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("pre-check failures reject without a ticket or a mutation", async () => {
    stub.detail.set("gone-cove", new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    stub.detail.set("sick-cove", new Response(JSON.stringify({ error: "request failed" }), { status: 500 }));
    stub.detail.set("moved-cove", new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    stub.detail.set("odd-ok", new Response("{}", { status: 204 }));
    const before = stub.requests.length;
    for (const method of ["agents.restart", "agents.interrupt", "agents.stop", "agents.remove"]) {
      await expect(bridge.handle(method, { connection: id, agent: "gone-cove" })).rejects.toThrow("This agent no longer exists");
      await expect(bridge.handle(method, { connection: id, agent: "sick-cove" })).rejects.toThrow("Couldn't check the agent (HTTP 500)");
      await expect(bridge.handle(method, { connection: id, agent: "moved-cove" })).rejects.toThrow("Couldn't check the agent (HTTP 302)");
      await expect(bridge.handle(method, { connection: id, agent: "odd-ok" })).rejects.toThrow("Couldn't check the agent (HTTP 204)");
    }
    expect(since(before).every((r) => r.method === "GET")).toBe(true);
  });

  test("a ticket is void once its connection is removed or points at another server", async () => {
    const conn = bridge.addConnection("Temp", stub.url, "stub-token");
    const pending = (await bridge.handle("agents.stop", { connection: conn.id, agent: "harbor-lights" })) as { confirm: { ticket: string } };
    await bridge.handle("connections.save", { id: conn.id, name: "Temp", url: "https://am.example.com", token: "other-token" });
    const before = stub.requests.length;
    await expect(bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).rejects.toThrow("The connection changed; try again");
    const conn2 = bridge.addConnection("Temp2", stub.url, "stub-token");
    const pending2 = (await bridge.handle("agents.stop", { connection: conn2.id, agent: "harbor-lights" })) as { confirm: { ticket: string } };
    await bridge.handle("connections.remove", { id: conn2.id });
    await expect(bridge.handle("dev.confirm", { ticket: pending2.confirm.ticket, accept: true })).rejects.toThrow(`unknown connection: ${conn2.id}`);
    expect(stub.requests.length).toBe(before + 1);
  });

  test("rejections: connection first, then agent, then params; nothing is sent", async () => {
    const before = stub.requests.length;
    const REJECT: [method: string, params: Record<string, unknown>, error: string][] = [
      ["agents.stop", { connection: "missing", agent: "a/b" }, "unknown connection: missing"],
      ["agents.create", { connection: "missing", name: "concierge" }, "unknown connection: missing"],
      ["agents.stop", { agent: "a/b" }, "invalid agent: a/b"],
      ["agents.remove", { agent: "an..nex:x" }, "invalid agent: an..nex:x"],
      ["agents.resume", { agent: null }, "invalid agent: null"],
      ["agents.rename", { agent: "harbor-lights", name: "concierge" }, "invalid name: concierge"],
      ["agents.rename", { agent: "harbor-lights", name: "a b" }, "invalid name: a b"],
      ["agents.move", { agent: "harbor-lights", host: "-annex" }, "invalid host: -annex"],
      ["agents.move", { agent: "harbor-lights", host: "annex", dir: "~/x" }, "invalid directory"],
      ["agents.model", { agent: "harbor-lights", createdAt: "x", status: "idle" }, "invalid model"],
      ["agents.model", { agent: "harbor-lights", model: "-x", createdAt: "x", status: "idle" }, "invalid model"],
      ["agents.model", { agent: "harbor-lights", model: "opus", effort: "", createdAt: "x", status: "idle" }, "invalid effort"],
      ["agents.model", { agent: "harbor-lights", model: "opus", createdAt: "", status: "idle" }, "invalid createdAt"],
      ["agents.model", { agent: "harbor-lights", model: "opus", createdAt: "x", status: "exited" }, "invalid status"],
      ["agents.handoff", { agent: "harbor-lights", to: "antigravity" }, "invalid to"],
      ["agents.handoff", { agent: "harbor-lights", to: "codex", newName: "concierge" }, "invalid name: concierge"],
      ["agents.handoff", { agent: "harbor-lights", to: "codex", full: "yes" }, "invalid full"],
      ["agents.create", { name: "concierge", task: "x", provider: "claude" }, "invalid name: concierge"],
      ["agents.create", { name: "n", task: " ", provider: "claude" }, "invalid task"],
      ["agents.create", { name: "n", task: "x\u001b", provider: "claude" }, "invalid task"],
      ["agents.create", { name: "n", task: "x", provider: "gemini" }, "invalid provider"],
      ["agents.create", { name: "n", task: "x", provider: "claude", dir: "rel" }, "invalid directory"],
      ["agents.create", { name: "n", task: "x", provider: "claude", dir: "~/x", host: "annex" }, "invalid directory"],
      ["agents.create", { name: "n", task: "x", provider: "claude", host: ".annex" }, "invalid host: .annex"],
      ["agents.create", { name: "n", task: "x", provider: "claude", model: "-m" }, "invalid model"],
      ["agents.create", { name: "n", task: "x", provider: "claude", effort: "a".repeat(65) }, "invalid effort"],
      ["agents.create", { name: "n", task: "x", provider: "claude", role: "concierge" }, "invalid role"],
      ["permissions.answer", { agent: "fog-signal", id: ULID.toLowerCase(), optionId: "accept" }, "invalid id"],
      ["permissions.answer", { agent: "fog-signal", id: ULID, optionId: "a b" }, "invalid optionId"],
      ["prompt.answer", { agent: "origami-docs", id: "x", optionId: "1" }, "invalid id"],
      ["prompt.answer", { agent: "origami-docs", id: PROMPT_ID, optionId: "0" }, "invalid optionId"],
      ["prompt.answer", { agent: "origami-docs", id: PROMPT_ID, optionId: "1", text: "two\nlines" }, "invalid text"],
      ["files.upload", { agent: "harbor-lights", type: "image/svg+xml", data: "AA==" }, "invalid type"],
      ["files.upload", { agent: "harbor-lights", type: "image/png", data: "not base64" }, "invalid data"],
      ["files.upload", { agent: "harbor-lights", type: "image/png", data: "" }, "invalid data"],
      ["files.upload", { agent: "harbor-lights", type: "image/gif", data: Buffer.from(PNG).toString("base64") }, "File is not a valid image/gif image"],
      ["search.query", { query: " a " }, "invalid query"],
      ["search.query", { query: "a".repeat(257) }, "invalid query"],
    ];
    for (const [method, params, error] of REJECT) await expect(bridge.handle(method, { connection: id, ...params })).rejects.toThrow(error);
    expect(stub.requests.length).toBe(before);
  });

  test("still no generic mutation or side door", async () => {
    for (const method of ["api.post", "api.delete", "agents.terminal", "agents.messages", "auth.login", "messages.interrupt"])
      await expect(bridge.handle(method, { connection: id, agent: "harbor-lights" })).rejects.toThrow(`unknown method: ${method}`);
    await expect(bridge.handle("messages.send", { connection: id, agent: "harbor-lights", text: "x", mode: "interrupt" })).rejects.toThrow("mode must be queue or now");
  });

  test("a network failure rejects once, never retried", async () => {
    const calls: string[] = [];
    const failing = (async (url: string) => {
      calls.push(url);
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const other = new DevBridge({ version: "t", build: "t" }, failing);
    const conn = other.addConnection("Down", "https://am.example.com", "x");
    await expect(other.handle("agents.resume", { connection: conn.id, agent: "harbor-lights" })).rejects.toThrow("network down");
    await expect(other.handle("agents.stop", { connection: conn.id, agent: "harbor-lights" })).rejects.toThrow("network down");
    expect(calls).toEqual(["https://am.example.com/api/agents/harbor-lights/resume", "https://am.example.com/api/agents/harbor-lights"]);
  });

  test("a timeout rejects and is not retried", async () => {
    let calls = 0;
    const hanging = ((_url: string, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    }) as unknown as typeof fetch;
    const other = new DevBridge({ version: "t", build: "t" }, hanging);
    const conn = other.addConnection("Slow", "https://am.example.com", "x");
    const original = AbortSignal.timeout;
    AbortSignal.timeout = (() => original.call(AbortSignal, 20)) as typeof AbortSignal.timeout;
    try {
      await expect(other.handle("concierge.ensure", { connection: conn.id })).rejects.toThrow();
    } finally {
      AbortSignal.timeout = original;
    }
    expect(calls).toBe(1);
  });
});

describe("dev server /__bridge body limit", () => {
  let server: ReturnType<typeof startDevServer>;
  beforeAll(() => {
    server = startDevServer({ port: 0, bridge: new DevBridge({ version: "t", build: "t" }), root: tmpdir() });
  });
  afterAll(() => server.stop());
  const post = (body: string) =>
    fetch(server.url + "/__bridge", { method: "POST", headers: { "content-type": "application/json", origin: server.url }, body });

  test("only files.upload may carry a 10 MiB image as base64", async () => {
    const data = Buffer.alloc(10 * 1024 * 1024).toString("base64");
    const upload = await post(JSON.stringify({ method: "files.upload", params: { connection: "missing", agent: "harbor-lights", type: "image/png", data } }));
    // Reached the bridge: refused on the connection, not on size.
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ error: "unknown connection: missing" });
    const big = await post(JSON.stringify({ method: "agents.create", params: { connection: "missing", task: "a".repeat(BRIDGE_BODY_MAX) } }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "request body too large" });
    const small = await post(JSON.stringify({ method: "agents.create", params: { connection: "missing", task: "a".repeat(100_000) } }));
    expect(await small.json()).toEqual({ error: "unknown connection: missing" });
    const huge = await post(JSON.stringify({ method: "files.upload", params: { data: "A".repeat(15 << 20) } }));
    expect(huge.status).toBe(413);
  });
});

describe("page bridge in browser dev mode", () => {
  let stub: ReturnType<typeof startStub>;
  let devBridge: DevBridge;
  let server: ReturnType<typeof startDevServer>;
  let connection: string;
  let answers: boolean[];
  let prompts: string[];
  const realFetch = globalThis.fetch;
  const hadWindow = "window" in globalThis;
  const realWindow = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    stub = startStub();
    devBridge = new DevBridge({ version: "t", build: "t" });
    connection = devBridge.addConnection("Stub motel", stub.url, "stub-token").id;
    server = startDevServer({ port: 0, bridge: devBridge, root: tmpdir() });
    // The page fetches "/__bridge" on its own origin.
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      realFetch(server.url + input, { ...init, headers: { ...(init?.headers as Record<string, string>), origin: server.url } })) as typeof fetch;
    (globalThis as { window?: unknown }).window = {
      confirm: (text: string) => {
        prompts.push(text);
        return answers.shift() ?? false;
      },
    };
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    if (hadWindow) (globalThis as { window?: unknown }).window = realWindow;
    else delete (globalThis as { window?: unknown }).window;
    server.stop();
    devBridge.stopAll();
    stub.stop();
  });

  test("accept: window.confirm shows title, body and server, then the request is sent", async () => {
    answers = [true];
    prompts = [];
    const before = stub.requests.length;
    expect(await call("agents.stop", { connection, agent: "harbor-lights" })).toEqual({ status: 200, body: { ok: true, echo: "POST" } });
    expect(prompts).toEqual([`Stop harbor-lights?\n\nThis interrupts its current work and ends its session. It can be resumed later. Status: working.\n\nServer: Stub motel (${stub.url.slice("http://".length)})`]);
    expect(stub.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/agents/harbor-lights", "GET /api/agents/harbor-lights", "POST /api/agents/harbor-lights/stop"]);
  });

  test("cancel resolves {cancelled: true} and sends nothing", async () => {
    answers = [false];
    prompts = [];
    const before = stub.requests.length;
    expect(await call("agents.remove", { connection, agent: "harbor-lights" })).toEqual({ cancelled: true });
    expect(prompts).toHaveLength(1);
    expect(stub.requests.slice(before).map((r) => r.method)).toEqual(["GET"]);
  });

  test("a pre-check 404 rejects without asking", async () => {
    stub.detail.set("gone-cove", new Response("{}", { status: 404 }));
    prompts = [];
    await expect(call("agents.interrupt", { connection, agent: "gone-cove" })).rejects.toThrow("This agent no longer exists");
    expect(prompts).toEqual([]);
  });

  test("a second confirmed call while one is open rejects", async () => {
    answers = [true];
    prompts = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stub.detail.set("slow-cove", async () => {
      await gate;
      return Response.json({ status: "idle" });
    });
    const first = call("agents.restart", { connection, agent: "slow-cove" });
    await expect(call("agents.stop", { connection, agent: "harbor-lights" })).rejects.toThrow("another confirmation is open");
    release();
    expect(await first).toEqual({ status: 200, body: { ok: true, echo: "POST" } });
    expect(prompts).toHaveLength(1);
    // Released once answered.
    answers = [false];
    expect(await call("agents.stop", { connection, agent: "harbor-lights" })).toEqual({ cancelled: true });
  });

  test("unconfirmed methods go straight through", async () => {
    prompts = [];
    expect(await call("agents.resume", { connection, agent: "harbor-lights" })).toEqual({ status: 200, body: { ok: true, echo: "POST" } });
    expect(prompts).toEqual([]);
  });

  test("terminal.open asks window.confirm once per connection per page load; cancel sends nothing", async () => {
    const terminalConnection = devBridge.addConnection("Stub\u202e motel", stub.url, "stub-token").id;
    answers = [false];
    prompts = [];
    const before = stub.requests.length;
    expect(await call("terminal.open", { connection: terminalConnection, agent: "keeper-log" })).toEqual({ cancelled: true });
    expect(prompts).toEqual([
      `Open interactive terminals on Stub motel?\n\nKeys you type in a terminal go straight to the agent's terminal on ${stub.url.slice("http://".length)}, including Ctrl-C and shell commands.`,
    ]);
    expect(stub.requests.length).toBe(before);
    // Asked again after a cancel; once allowed, not again. The stub answers sign-in without a session.
    answers = [true];
    await expect(call("terminal.open", { connection: terminalConnection, agent: "keeper-log" })).rejects.toThrow("The server did not start a terminal session");
    await expect(call("terminal.open", { connection: terminalConnection, agent: "keeper-log" })).rejects.toThrow("The server did not start a terminal session");
    expect(prompts).toHaveLength(2);
    expect(stub.requests.slice(before).map((r) => `${r.method} ${r.path} ${r.authorization}`)).toEqual(["POST /auth/login null", "POST /auth/login null"]);
    // The checks the native shell makes before its sheet come first; other terminal methods never ask.
    const other = devBridge.addConnection("Other", stub.url, "stub-token").id;
    await expect(call("terminal.open", { connection: "missing", agent: "keeper-log" })).rejects.toThrow("unknown connection: missing");
    await expect(call("terminal.open", { connection: other, agent: "bad name" })).rejects.toThrow("invalid agent: bad name");
    await expect(call("terminal.input", { id: "0123456789abcdef0123456789abcdef", data: "x" })).rejects.toThrow("unknown terminal");
    expect(await call("terminal.close", { id: "0123456789abcdef0123456789abcdef" })).toEqual({});
    expect(prompts).toHaveLength(2);
  });

  test("native mode forwards to the shell, which owns the pre-check and alert", async () => {
    const posted: unknown[] = [];
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    win.webkit = { messageHandlers: { am: { postMessage: async (message: unknown) => (posted.push(message), { cancelled: true }) } } };
    prompts = [];
    try {
      expect(await call("agents.stop", { connection, agent: "harbor-lights" })).toEqual({ cancelled: true });
    } finally {
      delete win.webkit;
    }
    expect(posted).toEqual([{ method: "agents.stop", params: { connection, agent: "harbor-lights" } }]);
    expect(prompts).toEqual([]);
  });

  test("native mode: terminal.open goes straight to the shell, which owns the consent sheet", async () => {
    const posted: unknown[] = [];
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    win.webkit = { messageHandlers: { am: { postMessage: async (message: unknown) => (posted.push(message), { cancelled: true }) } } };
    prompts = [];
    try {
      expect(await call("terminal.open", { connection: "native-connection", agent: "keeper-log" })).toEqual({ cancelled: true });
    } finally {
      delete win.webkit;
    }
    expect(posted).toEqual([{ method: "terminal.open", params: { connection: "native-connection", agent: "keeper-log" } }]);
    expect(prompts).toEqual([]);
  });
});

describe("dev bridge terminals", () => {
  let fixture: FixtureServer;
  let bridge: DevBridge;
  let connection: string;
  let events: [string, any][];
  // Every result and event, to prove the session cookie never reaches the page.
  let seen: unknown[];
  const PROMPT = "keeper@motel:~/code/lighthouse$ ";
  beforeAll(() => {
    fixture = startFixtureServer({ port: 0, flipMs: 60_000, transitionMs: 60 });
  });
  afterAll(() => fixture.stop());
  beforeEach(async () => {
    fixture.reset();
    bridge = new DevBridge({ version: "t", build: "t" });
    events = [];
    seen = [];
    bridge.subscribe((name, payload) => {
      events.push([name, payload]);
      seen.push(payload);
    });
    connection = bridge.addConnection("Fixture motel", fixture.url, FIXTURE_TOKEN).id;
  });
  afterEach(() => {
    bridge.stopAll();
    const cookies = [...((bridge as unknown as { sessions: Map<string, { cookie: string }> }).sessions.values())].map((session) => session.cookie);
    for (const cookie of cookies) expect(JSON.stringify(seen)).not.toContain(cookie);
    expect(JSON.stringify(seen)).not.toContain("__Host-am_session");
  });
  const handle = async (method: string, params: Record<string, unknown>) => {
    const result = await bridge.handle(method, params);
    seen.push(result);
    return result as any;
  };
  const open = (agent = "keeper-log", conn = connection) => handle("terminal.open", { connection: conn, agent });
  const until = async (check: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(5);
    }
  };
  const output = (id: string) =>
    Buffer.concat(events.filter(([name, payload]) => name === "terminal.output" && payload.id === id).map(([, payload]) => Buffer.from(payload.data, "base64"))).toString();
  const closed = (id: string) => events.filter(([name, payload]) => name === "terminal.closed" && payload.id === id).map(([, payload]) => payload);
  const controls = (id: string) => events.filter(([name, payload]) => name === "terminal.control" && payload.id === id).map(([, payload]) => payload.message);
  const logged = () => fixture.requests.filter((entry) => entry.path.startsWith("/auth") || entry.path.endsWith("/terminal")).map((entry) => `${entry.method} ${entry.status ?? ""}`.trim());
  const ready = async (id: string) => until(() => output(id).endsWith("$ "));

  test("open signs in, preflights and upgrades once; input, resize and output flow in order", async () => {
    const opened = await open();
    expect(opened).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), transport: "local" });
    await ready(opened.id);
    expect(controls(opened.id)).toEqual([{ type: "ready" }]);
    expect(output(opened.id)).toBe(PROMPT);
    expect(await handle("terminal.resize", { id: opened.id, cols: 132, rows: 43 })).toEqual({});
    for (const data of ["ec", "ho hi\r", "si", "ze\rnope\r"]) expect(await handle("terminal.input", { id: opened.id, data })).toEqual({});
    await until(() => output(opened.id).endsWith("nope: command not found\r\n" + PROMPT));
    expect(output(opened.id)).toBe(`${PROMPT}echo hi\r\nhi\r\n${PROMPT}size\r\n43 132\r\n${PROMPT}nope\r\nnope: command not found\r\n${PROMPT}`);
    expect(logged()).toEqual(["POST 200", "GET 200", "UPGRADE 101", "WS", "WS", "WS", "WS", "WS"]);
    expect(fixture.requests.filter((entry) => entry.method === "WS").map((entry) => entry.body)).toEqual([
      { type: "resize", cols: 132, rows: 43 },
      { type: "input", data: "ec" }, { type: "input", data: "ho hi\r" }, { type: "input", data: "si" }, { type: "input", data: "ze\rnope\r" },
    ]);
    // Every output event is base64 of at most 64 KiB.
    for (const [name, payload] of events) if (name === "terminal.output") expect(Buffer.from(payload.data, "base64").length).toBeLessThanOrEqual(64 * 1024);
    expect((await open("annex:kelp-forest")).transport).toBe("ssh");
  });

  test("the session is reused: a second terminal on the connection does not sign in again", async () => {
    const first = await open();
    const second = await open("night-watch");
    expect(second.id).not.toBe(first.id);
    expect(logged().filter((entry) => entry.startsWith("POST"))).toEqual(["POST 200"]);
    // Concurrent first opens on a fresh connection share one sign-in too.
    const other = bridge.addConnection("Again", fixture.url, FIXTURE_TOKEN).id;
    await Promise.all([open("keeper-log", other), open("crease-check", other)]);
    expect(logged().filter((entry) => entry.startsWith("POST"))).toEqual(["POST 200", "POST 200"]);
  });

  test("close: exactly one terminal.closed, then the id is dead; close is idempotent", async () => {
    const { id } = await open();
    await ready(id);
    expect(await handle("terminal.close", { id })).toEqual({});
    expect(await handle("terminal.close", { id })).toEqual({});
    expect(closed(id)).toEqual([{ id, code: 1000, reason: "Terminal closed" }]);
    await expect(bridge.handle("terminal.input", { id, data: "x" })).rejects.toThrow("unknown terminal");
    await expect(bridge.handle("terminal.resize", { id, cols: 80, rows: 24 })).rejects.toThrow("unknown terminal");
    await until(() => fixture.openTerminals().length === 0);
    await Bun.sleep(0);
    expect(closed(id)).toHaveLength(1);
  });

  test("rejections: ids, then values; connection, agent, cap and https before any request", async () => {
    const { id } = await open();
    const unknown = "0123456789abcdef0123456789abcdef";
    const vectors: [string, Record<string, unknown>, string][] = [
      ["terminal.input", { id: unknown, data: "x" }, "unknown terminal"],
      ["terminal.input", { id: "T1", data: "x" }, "unknown terminal"],
      ["terminal.input", { data: "x" }, "unknown terminal"],
      ["terminal.input", { id: unknown, data: "" }, "unknown terminal"],
      ["terminal.input", { id, data: "" }, "invalid data"],
      ["terminal.input", { id, data: "a".repeat(16385) }, "invalid data"],
      ["terminal.input", { id, data: 5 }, "invalid data"],
      ["terminal.resize", { id: unknown, cols: 1, rows: 1 }, "unknown terminal"],
      ["terminal.resize", { id, cols: 1, rows: 1 }, "invalid cols"],
      ["terminal.resize", { id, cols: 80, rows: 201 }, "invalid rows"],
      ["terminal.resize", { id, cols: "80", rows: 24 }, "invalid cols"],
      ["terminal.open", { connection: "missing", agent: "keeper-log" }, "unknown connection: missing"],
      ["terminal.open", { connection, agent: "bad name" }, "invalid agent: bad name"],
      ["terminal.open", { connection, agent: "a:b:c" }, "invalid agent: a:b:c"],
      ["terminal.open", { connection, agent: null }, "invalid agent: null"],
    ];
    for (const [method, params, error] of vectors) await expect(bridge.handle(method, params)).rejects.toThrow(error);
    expect(await handle("terminal.close", { id: "not-an-id" })).toEqual({});
    expect(await handle("terminal.close", {})).toEqual({});
    const before = fixture.requests.length;
    const tailnet = bridge.addConnection("Tailnet", "http://100.64.0.1:8790", "x").id;
    await expect(bridge.handle("terminal.open", { connection: tailnet, agent: "keeper-log" })).rejects.toThrow("Terminals need an https connection");
    await expect(bridge.handle("terminal.open", { connection: tailnet, agent: "bad name" })).rejects.toThrow("invalid agent: bad name");
    expect(fixture.requests.length).toBe(before);
    expect(closed(id)).toEqual([]);
  });

  test("at most 4 terminals, counting ones still opening", async () => {
    const ids = (await Promise.all(["keeper-log", "night-watch", "crease-check", "ebb-report"].map((agent) => open(agent)))).map((r) => r.id);
    const before = fixture.requests.length;
    await expect(bridge.handle("terminal.open", { connection, agent: "concierge" })).rejects.toThrow("Too many terminals open");
    const tailnet = bridge.addConnection("Tailnet", "http://100.64.0.1:8790", "x").id;
    await expect(bridge.handle("terminal.open", { connection: tailnet, agent: "concierge" })).rejects.toThrow("Terminals need an https connection");
    expect(fixture.requests.length).toBe(before);
    await handle("terminal.close", { id: ids[0] });
    expect((await open("concierge")).transport).toBe("local");
    expect(bridge.openTerminalCount).toBe(4);
  });

  test("4001: terminal.closed with the server's code, no reconnect; the next open signs in again exactly once", async () => {
    const { id } = await open();
    await ready(id);
    await fetch(fixture.url + "/__fixture/terminal/expire", { method: "POST", headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } });
    await until(() => closed(id).length > 0);
    expect(controls(id).at(-1)).toEqual({ type: "error", message: "Session expired or revoked" });
    expect(closed(id)).toEqual([{ id, code: 4001, reason: "Session expired or revoked" }]);
    // The 4001 dropped the session: the next open signs in first, once.
    const again = await open();
    expect(again.transport).toBe("local");
    expect(logged().filter((entry) => !entry.startsWith("WS"))).toEqual(["POST 200", "GET 200", "UPGRADE 101", "POST 200", "GET 200", "UPGRADE 101"]);
    await Bun.sleep(20);
    expect(closed(id)).toHaveLength(1);
  });

  test("a session the server forgot (restart): one re-sign-in and the open succeeds", async () => {
    const { id } = await open();
    await ready(id);
    fixture.reset();
    await until(() => closed(id).length > 0);
    expect(closed(id)).toEqual([{ id, code: 1001, reason: "Server stopping" }]);
    expect((await open()).transport).toBe("local");
    expect(logged()).toEqual(["GET 401", "POST 200", "GET 200", "UPGRADE 101"]);
  });

  test("a 401 again after signing in again is final", async () => {
    const calls: string[] = [];
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url.slice(url.lastIndexOf("/")));
      if (url.endsWith("/auth/login")) return new Response("{}", { headers: { "set-cookie": `__Host-am_session=${"s".repeat(43)}; Path=/` } });
      if (url.endsWith("/terminal")) return Response.json({ error: "Web terminal requires a browser session" }, { status: 401 });
      return fetch(input, init);
    }) as typeof fetch;
    const stubbed = new DevBridge({ version: "t", build: "t" }, stub);
    const id = stubbed.addConnection("Stub", "https://am.example.com", "x").id;
    await expect(stubbed.handle("terminal.open", { connection: id, agent: "keeper-log" })).rejects.toThrow("The server rejected the terminal session");
    expect(calls).toEqual(["/login", "/terminal", "/login", "/terminal"]);
  });

  test("sign-in and preflight failures, in plain words", async () => {
    const answers: Record<string, Response | (() => Response)> = {};
    const calls: string[] = [];
    const stub = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const answer = answers[url.endsWith("/auth/login") ? "login" : "preflight"];
      if (!answer) throw new TypeError("fetch failed");
      return typeof answer === "function" ? answer() : answer.clone();
    }) as typeof fetch;
    const stubbed = new DevBridge({ version: "t", build: "t" }, stub);
    const id = stubbed.addConnection("Stub", "https://am.example.com", "x").id;
    const attempt = () => stubbed.handle("terminal.open", { connection: id, agent: "keeper-log" });
    const origin = "This server only allows terminals from its own web address. Connect the app to that address to use terminals.";
    const loginVectors: [Response | undefined, string][] = [
      [Response.json({ error: "Invalid access key" }, { status: 401 }), "The server rejected the access token"],
      [Response.json({ error: "origin rejected" }, { status: 403 }), origin],
      [Response.json({ error: "not found" }, { status: 404 }), "This server has no web sign-in, so terminals are unavailable"],
      [Response.json({ error: "Too many attempts. Wait a minute." }, { status: 429 }), "Too many sign-in attempts. Wait a minute and try again."],
      [new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }), "The server returned HTTP 302"],
      [Response.json({ ok: true }), "The server did not start a terminal session"],
      [Response.json({ ok: true }, { headers: { "set-cookie": "other=abcdefghijklmnopqrstuvwxyz" } }), "The server did not start a terminal session"],
      [undefined, "Couldn't reach the server"],
    ];
    for (const [response, error] of loginVectors) {
      if (response) answers.login = response;
      else delete answers.login;
      await expect(attempt()).rejects.toThrow(error);
    }
    // Each failed sign-in was tried once; a 429 is surfaced, not retried.
    expect(calls).toHaveLength(loginVectors.length);
    answers.login = new Response("{}", { headers: { "set-cookie": `__Host-am_session=${"s".repeat(43)}; Path=/; HttpOnly` } });
    const preflightVectors: [Response | undefined, string][] = [
      [Response.json({ error: "Agent is stopped; resume it before attaching" }, { status: 409 }), "Agent is stopped; resume it before attaching"],
      [Response.json({ error: "origin rejected" }, { status: 403 }), origin],
      [Response.json({ error: "Too many terminal requests" }, { status: 429 }), "Too many terminal connections"],
      [Response.json({ error: "ssh lantern: down" }, { status: 502 }), "The server returned HTTP 502"],
      [Response.json({ available: true, transport: "telnet" }), "This server did not answer like Agent Motel"],
      [undefined, "Couldn't reach the server"],
    ];
    for (const [response, error] of preflightVectors) {
      if (response) answers.preflight = response;
      else delete answers.preflight;
      await expect(attempt()).rejects.toThrow(error);
    }
  });

  test("against the fixture: wrong token, wrong origin, stopped, unreachable and missing agents", async () => {
    const wrong = bridge.addConnection("Wrong", fixture.url, "wrong-token").id;
    await expect(bridge.handle("terminal.open", { connection: wrong, agent: "keeper-log" })).rejects.toThrow("The server rejected the access token");
    const localhost = bridge.addConnection("Localhost", fixture.url.replace("127.0.0.1", "localhost"), FIXTURE_TOKEN).id;
    await expect(bridge.handle("terminal.open", { connection: localhost, agent: "keeper-log" })).rejects.toThrow(
      "This server only allows terminals from its own web address. Connect the app to that address to use terminals.",
    );
    const vectors: [string, string][] = [
      ["old-lens", "Agent is stopped; resume it before attaching"],
      ["paper-trail", "Agent terminal is unavailable (tmux session missing)"],
      ["nobody", "Agent no longer exists under this name"],
      ["annex:nobody", 'no agent matches "nobody"'],
      ["lantern:beacon", "The server returned HTTP 502"],
      ["elsewhere:x", 'unknown host "elsewhere" (not in config.remotes)'],
    ];
    for (const [agent, error] of vectors) await expect(bridge.handle("terminal.open", { connection, agent })).rejects.toThrow(error);
    const down = bridge.addConnection("Down", "http://127.0.0.1:9", FIXTURE_TOKEN).id;
    await expect(bridge.handle("terminal.open", { connection: down, agent: "keeper-log" })).rejects.toThrow("Couldn't reach the server");
    expect(bridge.openTerminalCount).toBe(0);
  });

  test("exit: the control message, then terminal.closed with the server's code", async () => {
    const { id } = await open();
    await ready(id);
    await handle("terminal.input", { id, data: "exit\r" });
    await until(() => closed(id).length > 0);
    expect(controls(id)).toEqual([{ type: "ready" }, { type: "exit", code: 0 }]);
    expect(closed(id)).toEqual([{ id, code: 1000, reason: "Terminal detached" }]);
    expect(output(id)).toBe(PROMPT + "exit\r\n");
    // Output, controls and the close arrive in that order.
    const order = events.filter(([, payload]) => payload.id === id).map(([name]) => name);
    expect(order.at(-1)).toBe("terminal.closed");
    expect(order.at(-2)).toBe("terminal.control");
  });

  test("an input frame the server refuses closes with its 1008", async () => {
    const { id } = await open();
    await ready(id);
    // 16 KiB of three-byte characters is within the bridge's character count but not the byte limit.
    await expect(bridge.handle("terminal.input", { id, data: "€".repeat(5462) })).rejects.toThrow("invalid data");
    await handle("terminal.input", { id, data: "€".repeat(5461) });
    await handle("terminal.input", { id, data: "\x03" });
    await until(() => output(id).endsWith("^C\r\n" + PROMPT));
    expect(closed(id)).toEqual([]);
  });

  test("connections.remove and a URL change close the connection's terminals (1006); a new token only drops the session", async () => {
    const { id } = await open();
    const other = bridge.addConnection("Other", fixture.url, FIXTURE_TOKEN).id;
    const kept = await open("night-watch", other);
    await handle("connections.remove", { id: connection });
    // Events of a terminal wait until its open has returned; it may still be within that turn.
    await until(() => closed(id).length > 0);
    expect(closed(id)).toEqual([{ id, code: 1006, reason: "The connection was removed or changed" }]);
    expect(closed(kept.id)).toEqual([]);
    await handle("connections.save", { id: other, name: "Renamed only", url: fixture.url });
    const logins = () => logged().filter((entry) => entry.startsWith("POST")).length;
    const before = logins();
    await open("crease-check", other);
    expect(logins()).toBe(before);
    await handle("connections.save", { id: other, name: "New token", url: fixture.url, token: FIXTURE_TOKEN });
    await open("ebb-report", other);
    expect(logins()).toBe(before + 1);
    expect(closed(kept.id)).toEqual([]);
    await handle("connections.save", { id: other, name: "Moved", url: fixture.url.replace("127.0.0.1", "localhost"), token: FIXTURE_TOKEN });
    await until(() => closed(kept.id).length > 0);
    expect(closed(kept.id)).toEqual([{ id: kept.id, code: 1006, reason: "The connection was removed or changed" }]);
    await until(() => fixture.openTerminals().length === 0);
  });

  test("a flood is relayed whole and in order, coalesced into events of at most 64 KiB", async () => {
    await fetch(fixture.url + "/__fixture/terminal/flood", { method: "POST", headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } });
    const { id } = await open();
    await until(() => output(id).length >= FLOOD_BYTES + PROMPT.length, 20_000);
    let expected = PROMPT;
    for (let i = 0; i < FLOOD_BYTES / 64; i++) expected += floodLine(i);
    expect(output(id) === expected).toBe(true);
    const sizes = events.filter(([name, payload]) => name === "terminal.output" && payload.id === id).map(([, payload]) => Buffer.from(payload.data, "base64").length);
    expect(Math.max(...sizes)).toBe(64 * 1024);
    expect(sizes.length).toBeGreaterThanOrEqual(FLOOD_BYTES / (64 * 1024));
    expect(closed(id)).toEqual([]);
  });

  test("more than 4 MiB the page has not taken closes with 1013, once, and detaches from the server", async () => {
    // A page that never takes its events.
    bridge.subscribe(() => new Promise(() => {}));
    await fetch(fixture.url + "/__fixture/terminal/flood", { method: "POST", headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } });
    const { id } = await open();
    await until(() => closed(id).length > 0, 20_000);
    expect(closed(id)).toEqual([{ id, code: 1013, reason: "Output exceeded rendering capacity" }]);
    // Emitted but never taken: at most the cap (under load it can even trip before the first event).
    expect(output(id).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    await until(() => fixture.openTerminals().length === 0);
    await Bun.sleep(20);
    expect(closed(id)).toHaveLength(1);
  });

  test("closeAllTerminals (the page went away) closes every terminal without events; an open in progress fails", async () => {
    const first = await open();
    const second = await open("night-watch");
    bridge.closeAllTerminals();
    await until(() => fixture.openTerminals().length === 0);
    await Bun.sleep(20);
    expect([...closed(first.id), ...closed(second.id)]).toEqual([]);
    expect(bridge.openTerminalCount).toBe(0);
    // A page reload while a terminal is opening.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new DevBridge({ version: "t", build: "t" }, (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/terminal")) await gate;
      return fetch(input, init);
    }) as typeof fetch);
    const id = slow.addConnection("Slow", fixture.url, FIXTURE_TOKEN).id;
    const pending = slow.handle("terminal.open", { connection: id, agent: "keeper-log" });
    await until(() => fixture.requests.some((entry) => entry.path === "/auth/login"));
    slow.closeAllTerminals();
    release();
    await expect(pending).rejects.toThrow("The page changed while the terminal was opening");
    expect(slow.openTerminalCount).toBe(0);
    await until(() => fixture.openTerminals().length === 0);
  });
});

describe("dev server terminal relay", () => {
  let fixture: FixtureServer;
  let devBridge: DevBridge;
  let server: ReturnType<typeof startDevServer>;
  let connection: string;
  beforeAll(() => {
    fixture = startFixtureServer({ port: 0, flipMs: 60_000 });
    devBridge = new DevBridge({ version: "t", build: "t" });
    connection = devBridge.addConnection("Fixture motel", fixture.url, FIXTURE_TOKEN).id;
    server = startDevServer({ port: 0, bridge: devBridge, root: tmpdir() });
  });
  afterAll(() => {
    server.stop();
    devBridge.stopAll();
    fixture.stop();
  });
  const post = async (method: string, params: unknown) =>
    (await fetch(server.url + "/__bridge", { method: "POST", headers: { origin: server.url, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })).json() as Promise<any>;

  test("events reach the page over the bridge stream; the cookie never does; a disconnect closes the page's terminals", async () => {
    const controller = new AbortController();
    const stream = await fetch(server.url + "/__bridge/events", { headers: { origin: server.url }, signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    })().catch(() => {});
    const opened = await post("terminal.open", { connection, agent: "keeper-log" });
    expect(opened.result).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), transport: "local" });
    const id = opened.result.id;
    expect((await post("terminal.input", { id, data: "echo relayed\r" })).result).toEqual({});
    const relayed = () =>
      text.split("\n\n").filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6))).filter((event) => event.payload?.id === id);
    const decoded = () => Buffer.concat(relayed().filter((event) => event.name === "terminal.output").map((event) => Buffer.from(event.payload.data, "base64"))).toString();
    const deadline = Date.now() + 5000;
    while (!decoded().includes("relayed\r\n") && Date.now() < deadline) await Bun.sleep(5);
    expect(decoded()).toContain("echo relayed\r\nrelayed\r\n");
    expect(relayed()[0]).toEqual({ name: "terminal.control", payload: { id, message: { type: "ready" } } });
    const cookies = [...((devBridge as unknown as { sessions: Map<string, { cookie: string }> }).sessions.values())].map((session) => session.cookie);
    expect(cookies).toHaveLength(1);
    expect(text).not.toContain(cookies[0]!);
    expect(JSON.stringify(opened)).not.toContain(cookies[0]!);
    expect((await post("terminal.input", { id: "nope", data: "x" })).error).toBe("unknown terminal");
    controller.abort();
    await pump;
    const until = Date.now() + 5000;
    while ((devBridge.openTerminalCount > 0 || fixture.openTerminals().length > 0) && Date.now() < until) await Bun.sleep(5);
    expect(devBridge.openTerminalCount).toBe(0);
    expect(fixture.openTerminals()).toEqual([]);
  });
});
