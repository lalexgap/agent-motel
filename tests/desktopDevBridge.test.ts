import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_BODY_MAX, DEV_CSP, startDevServer } from "../desktop/dev";
import { bridgeRequestAllowed, DevBridge, MUTATION_TIMEOUT_MS } from "../desktop/devBridge";
import { call } from "../desktop/src/bridge";
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

  test("confirmed methods: pre-check only, then the stored request once per accepted ticket", async () => {
    for (const [method, params, title, body, defaultIsCancel, expected, timeout] of CONFIRMED) {
      const before = stub.requests.length;
      const timeouts = recordTimeouts();
      try {
        const pending = (await bridge.handle(method, { connection: id, ...params })) as { confirm: { ticket: string } };
        expect(pending as unknown).toEqual({ confirm: { ticket: expect.any(String), title, body, button: expect.any(String), defaultIsCancel, server: "Stub motel" } });
        const key = expected.path.split("/")[3];
        // Nothing but the exact-name detail GET until the ticket is redeemed.
        expect(since(before)).toEqual([{ method: "GET", path: `/api/agents/${key}`, authorization: "Bearer stub-token", contentType: null, body: null, bytes: null }]);
        expect(await bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).toEqual({ status: 200, body: { ok: true, echo: expected.method } });
        expect(since(before + 1)).toEqual([expected]);
        await expect(bridge.handle("dev.confirm", { ticket: pending.confirm.ticket, accept: true })).rejects.toThrow("This confirmation has expired or was already answered");
        expect(stub.requests.length).toBe(before + 2);
      } finally {
        timeouts.restore();
      }
      expect(timeouts.seen).toEqual([15_000, timeout]);
    }
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
    expect(prompts).toEqual(["Stop harbor-lights?\n\nThis interrupts its current work and ends its session. It can be resumed later. Status: working.\n\nServer: Stub motel"]);
    expect(stub.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/agents/harbor-lights", "POST /api/agents/harbor-lights/stop"]);
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
});
