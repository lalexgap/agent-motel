import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIXTURE_TOKEN, startFixtureServer, type FixtureServer } from "../desktop/fixtures/server";

let fixture: FixtureServer;
beforeAll(() => {
  fixture = startFixtureServer({ port: 0, flipMs: 100 });
});
afterAll(() => fixture.stop());

const get = (path: string, token: string | null = FIXTURE_TOKEN, init: RequestInit = {}) =>
  fetch(fixture.url + path, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {} });
const body = async (path: string): Promise<any> => (await get(path)).json();

describe("fixture am server", () => {
  test("binds loopback and requires the bearer token", async () => {
    expect(fixture.url).toStartWith("http://127.0.0.1:");
    for (const token of [null, "wrong"]) {
      const response = await get("/api/health", token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect((await get("/api/events", null)).status).toBe(401);
    expect(await body("/api/health")).toEqual({ ok: true, name: "am" });
  });

  test("only the two message routes accept anything but GET", async () => {
    expect((await get("/api/agents", FIXTURE_TOKEN, { method: "POST" })).status).toBe(405);
    expect((await get("/api/agents/keeper-log", FIXTURE_TOKEN, { method: "DELETE" })).status).toBe(405);
    expect((await get("/api/agents/keeper-log/messages", FIXTURE_TOKEN, { method: "PUT" })).status).toBe(405);
  });

  test("hosts and agents follow the contract shapes", async () => {
    const hosts = await body("/api/hosts");
    expect(hosts.local).toBe("motel");
    expect(hosts.hosts).toContainEqual({ name: "annex", reachable: true });
    const agents = await body("/api/agents");
    expect(Array.isArray(agents.rows)).toBe(true);
    expect(agents.unreachable).toEqual(["lantern"]);
    expect(agents.rows.length).toBeGreaterThanOrEqual(12);
    const statuses = new Set(agents.rows.map((row: { status: string }) => row.status));
    for (const status of ["starting", "idle", "working", "waiting", "needs-attention", "exited", "dead"]) expect(statuses).toContain(status);
    expect(new Set(agents.rows.map((row: { provider: string }) => row.provider))).toEqual(new Set(["claude", "codex", "antigravity"]));
    for (const row of agents.rows) {
      expect(typeof row.name).toBe("string");
      expect(Number.isFinite(Date.parse(row.statusChangedAt))).toBe(true);
      expect(Number.isFinite(Date.parse(row.updatedAt))).toBe(true);
      expect(typeof row.dir).toBe("string");
    }
    expect(agents.rows.some((row: { host?: string; repoRoot?: string }) => !row.host && !row.repoRoot)).toBe(true);
  });

  test("detail and transcript, including a remote host:name key", async () => {
    const detail = await body("/api/agents/harbor-lights");
    expect(detail).toMatchObject({ name: "harbor-lights", status: "working", provider: "claude", queue: [], pane: "", pendingPermissions: 0 });
    const transcript = await body("/api/agents/harbor-lights/transcript");
    expect(transcript.total).toBe(transcript.entries.length);
    const kinds = new Set(transcript.entries.map((entry: { kind: string }) => entry.kind));
    expect(kinds).toEqual(new Set(["user", "assistant", "tool"]));
    const texts = transcript.entries.map((entry: { text?: string }) => entry.text || "");
    expect(texts.some((text: string) => text.startsWith("<task-notification>"))).toBe(true);
    expect(texts.some((text: string) => text.startsWith("[am · from tide-pilot]"))).toBe(true);
    expect(texts.some((text: string) => /^\[am\] PR #12 merged/.test(text))).toBe(true);
    expect(texts.some((text: string) => text.includes("| --- |") && text.includes("```"))).toBe(true);
    const indexes = transcript.entries.map((entry: { index: number }) => entry.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    const remote = await body("/api/agents/" + encodeURIComponent("annex:kelp-forest") + "/transcript");
    expect(remote.provider).toBe("codex");
    expect(remote.entries.length).toBeGreaterThan(0);
    expect((await get("/api/agents/nobody")).status).toBe(404);
  });

  test("events stream sends ready, then fleet events as drift-net flips", async () => {
    const controller = new AbortController();
    const response = await fetch(fixture.url + "/api/events", { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` }, signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!/event: fleet\n/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text.indexOf("event: ready\n")).toBe(0);
    expect(text).toMatch(/event: fleet\ndata: \{.*"agent":"drift-net"/);
  });
});

describe("fixture message routes", () => {
  let server: FixtureServer;
  beforeAll(() => {
    server = startFixtureServer({ port: 0, flipMs: 60_000, deliverMs: 60, replyMs: 60 });
  });
  afterAll(() => server.stop());
  const call = (method: string, path: string, payload?: unknown, token: string | null = FIXTURE_TOKEN) =>
    fetch(server.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
    });
  const read = async (path: string): Promise<any> => (await call("GET", path)).json();
  const until = async (check: () => Promise<boolean>, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(15);
    }
  };

  test("errors: 400, 404, 409 no_session", async () => {
    expect((await call("POST", "/api/agents/keeper-log/messages", { text: "  ", mode: "now" })).status).toBe(400);
    expect((await call("POST", "/api/agents/keeper-log/messages", "not json")).status).toBe(400);
    expect((await call("POST", "/api/agents/keeper-log/messages", { text: "x", mode: "interrupt" })).status).toBe(400);
    const missing = await call("POST", "/api/agents/nobody/messages", { text: "x", mode: "now" });
    expect(missing.status).toBe(404);
    const stopped = await call("POST", "/api/agents/old-lens/messages", { text: "x", mode: "now" });
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toMatchObject({ reason: "no_session" });
    expect((await call("DELETE", "/api/agents/nobody/messages/01A")).status).toBe(404);
    expect((await call("DELETE", "/api/agents/keeper-log/messages/01NOSUCHMESSAGE")).status).toBe(404);
  });

  test("now to an idle agent: queued briefly, delivered as a user turn, answered, idle again", async () => {
    const response = await call("POST", "/api/agents/keeper-log/messages", { text: "  summarise the timeline  ", mode: "now" });
    const sent = await response.json();
    expect(sent).toMatchObject({ ok: true, mode: "now" });
    expect(sent.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await read("/api/agents/keeper-log")).queue).toEqual([{ message: "summarise the timeline", queuedAt: expect.any(String) }]);
    await until(async () => (await read("/api/agents/keeper-log/transcript")).entries.at(-1)?.text === "summarise the timeline");
    expect((await read("/api/agents/keeper-log")).status).toBe("working");
    expect((await read("/api/agents/keeper-log")).queue).toEqual([]);
    await until(async () => (await read("/api/agents/keeper-log/transcript")).entries.at(-1)?.kind === "assistant");
    expect((await read("/api/agents/keeper-log")).status).toBe("idle");
    const cancel = await call("DELETE", `/api/agents/keeper-log/messages/${sent.id}`);
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toMatchObject({ reason: "already_delivered", state: "delivered" });
  });

  test("queue to a busy agent waits and can be cancelled", async () => {
    const sent = await (await call("POST", "/api/agents/harbor-lights/messages", { text: "after this, tidy up", mode: "queue" })).json();
    await Bun.sleep(200);
    const detail = await read("/api/agents/harbor-lights");
    expect(detail.status).toBe("working");
    // Like am, the record id is not listed: the entry has no msgId.
    expect(detail.queue).toEqual([{ message: "after this, tidy up", queuedAt: expect.any(String) }]);
    expect((await read("/api/agents")).rows.find((row: { name: string }) => row.name === "harbor-lights").queued).toBe(1);
    const cancel = await call("DELETE", `/api/agents/harbor-lights/messages/${sent.id}`);
    expect(await cancel.json()).toEqual({ ok: true, state: "cancelled" });
    expect((await read("/api/agents/harbor-lights")).queue).toEqual([]);
    expect((await call("DELETE", `/api/agents/harbor-lights/messages/${sent.id}`)).status).toBe(409);
  });

  test("now to the always-busy agent is delivered and it stays working", async () => {
    await call("POST", "/api/agents/harbor-lights/messages", { text: "steer left", mode: "now" });
    await until(async () => (await read("/api/agents/harbor-lights/transcript")).entries.at(-1)?.kind === "assistant");
    expect((await read("/api/agents/harbor-lights")).status).toBe("working");
  });

  test("seeded queue: a peer message whose msgId has no record (DELETE 404), then one without a msgId", async () => {
    const detail = await read("/api/agents/tide-pilot");
    expect(detail.queue).toHaveLength(2);
    const [peer, plain] = detail.queue;
    expect(peer.msgId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(plain.msgId).toBeUndefined();
    expect(plain.message).toBeTruthy();
    expect((await call("DELETE", `/api/agents/tide-pilot/messages/${peer.msgId}`)).status).toBe(404);
    expect((await read("/api/agents/tide-pilot")).queue).toHaveLength(2);
  });

  test("request log lists every mutation, bearer-gated", async () => {
    expect((await call("GET", "/__fixture/requests", undefined, null)).status).toBe(401);
    const log = await read("/__fixture/requests");
    expect(log[0]).toEqual({ method: "POST", path: "/api/agents/keeper-log/messages", body: { text: "  ", mode: "now" } });
    expect(log[1]).toEqual({ method: "POST", path: "/api/agents/keeper-log/messages", body: "not json" });
    expect(log.every((entry: { method: string }) => entry.method !== "GET")).toBe(true);
    expect(log).toEqual(server.requests);
  });

  test("events: each step emits a fleet event", async () => {
    const controller = new AbortController();
    const response = await fetch(server.url + "/api/events", { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` }, signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    await call("POST", "/api/agents/crease-check/messages", { text: "one more pass", mode: "queue" });
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while ((text.match(/event: fleet\n/g) ?? []).length < 3 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain('"state":"queued"');
    expect(text).toContain('"state":"delivered"');
    expect(text).toContain('"status":"idle"');
  });
});
