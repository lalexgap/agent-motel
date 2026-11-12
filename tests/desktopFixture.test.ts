import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FIXTURE_IDS, FIXTURE_TOKEN, startFixtureServer, type FixtureServer } from "../desktop/fixtures/server";

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

  test("unknown routes and methods are 404 not found, like am", async () => {
    for (const [method, path] of [["PUT", "/api/agents/keeper-log/messages"], ["GET", "/api/agents/keeper-log/messages"], ["POST", "/api/nothing"], ["PATCH", "/api/agents/keeper-log"]]) {
      const response = await get(path!, FIXTURE_TOKEN, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
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

  test("the concierge route names a row that has the concierge role", async () => {
    const { key } = await body("/api/concierge");
    expect(key).toBe("concierge");
    const agents = await body("/api/agents");
    expect(agents.rows.find((row: { name: string }) => row.name === key)).toMatchObject({ role: "concierge", provider: "claude", status: "idle", dir: "/home/keeper" });
    const transcript = await body("/api/agents/concierge/transcript");
    expect(transcript.entries.some((entry: { kind: string }) => entry.kind === "assistant")).toBe(true);
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
    const control = await call("POST", "/api/agents/keeper-log/messages", { text: "stop\u001b", mode: "now" });
    expect(control.status).toBe(400);
    expect((await control.json()).error).toMatch(/control character/);
    const missing = await call("POST", "/api/agents/nobody/messages", { text: "x", mode: "now" });
    expect(missing.status).toBe(404);
    const stopped = await call("POST", "/api/agents/old-lens/messages", { text: "x", mode: "now" });
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toMatchObject({ reason: "no_session" });
    expect((await call("DELETE", "/api/agents/nobody/messages/01A")).status).toBe(404);
    expect((await call("DELETE", "/api/agents/keeper-log/messages/01NOSUCHMESSAGE")).status).toBe(404);
  });

  test("now to an idle agent: never listed in the queue, delivered as a user turn, answered, idle again", async () => {
    const response = await call("POST", "/api/agents/keeper-log/messages", { text: "  summarise the timeline  ", mode: "now" });
    const sent = await response.json();
    expect(sent).toMatchObject({ ok: true, mode: "now" });
    expect(sent.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Like am, a now message goes straight to the pane: not listed, not counted, not cancellable.
    expect((await read("/api/agents/keeper-log")).queue).toEqual([]);
    expect((await read("/api/agents")).rows.find((row: { name: string }) => row.name === "keeper-log").queued).toBeUndefined();
    const early = await call("DELETE", `/api/agents/keeper-log/messages/${sent.id}`);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ reason: "already_delivered", state: "delivered" });
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
    expect((await read("/api/agents/harbor-lights")).queue).toEqual([]);
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

describe("fixture parity routes", () => {
  let server: FixtureServer;
  beforeAll(() => {
    server = startFixtureServer({ port: 0, flipMs: 60_000, deliverMs: 40, replyMs: 40, transitionMs: 60 });
  });
  afterAll(() => server.stop());
  beforeEach(async () => {
    expect((await call("POST", "/__fixture/reset")).status).toBe(200);
  });
  const call = (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}, token: string | null = FIXTURE_TOKEN) =>
    fetch(server.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(payload === undefined ? {} : { body: payload instanceof Uint8Array || typeof payload === "string" ? payload : JSON.stringify(payload) }),
    });
  const expectReply = async (response: Response | Promise<Response>, status: number, body?: unknown) => {
    const resolved = await response;
    const data = await resolved.json();
    expect({ status: resolved.status, data }).toMatchObject({ status, ...(body === undefined ? {} : { data: body }) });
    return data as any;
  };
  const read = async (path: string): Promise<any> => (await call("GET", path)).json();
  const row = async (name: string, host?: string): Promise<any> =>
    (await read("/api/agents")).rows.find((item: { name: string; host?: string }) => item.name === name && item.host === host);
  // Poll for a state with a generous deadline instead of asserting inside a timer window.
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(10);
    }
  };
  const statusIs = (name: string, status: string, host?: string) => until(async () => (await row(name, host))?.status === status);
  const enc = encodeURIComponent;

  test("reset is bearer-gated, restores the seeded fleet and clears the request log", async () => {
    expect((await call("POST", "/__fixture/reset", undefined, {}, null)).status).toBe(401);
    await expectReply(call("DELETE", "/api/agents/keeper-log"), 200, { ok: true });
    await call("POST", "/api/agents/old-lens/resume", {});
    expect(await row("keeper-log")).toBeUndefined();
    expect((await read("/__fixture/requests")).length).toBe(2);
    await expectReply(call("POST", "/__fixture/reset"), 200, { ok: true });
    expect(await read("/__fixture/requests")).toEqual([]);
    expect(await row("keeper-log")).toMatchObject({ status: "idle" });
    expect(await row("old-lens")).toMatchObject({ status: "exited" });
    expect(server.rows.find((item) => item.name === "keeper-log")).toBeDefined();
  });

  test("pre-existing behaviours hold after a reset", async () => {
    const rows = (await read("/api/agents")).rows;
    const by = (name: string) => rows.find((item: { name: string; host?: string }) => item.name === name && !item.host);
    expect(by("harbor-lights").status).toBe("working");
    expect(by("keeper-log").status).toBe("idle");
    expect(by("old-lens").status).toBe("exited");
    expect(by("night-watch").provider).toBe("antigravity");
    expect(by("concierge").role).toBe("concierge");
    expect(by("tide-pilot").queued).toBe(2);
    expect((await read("/api/agents/tide-pilot")).queue).toHaveLength(2);
  });

  test("agent keys: malformed, invalid name or host, unknown host, unreachable host", async () => {
    await expectReply(call("GET", "/api/agents/%E0%A4%A"), 400, { error: "malformed agent name" });
    await expectReply(call("GET", "/api/agents/" + enc("bad name")), 400, { error: 'invalid agent name "bad name"' });
    await expectReply(call("GET", "/api/agents/" + enc("bad host:x")), 400, { error: 'invalid host "bad host"' });
    await expectReply(call("GET", "/api/agents/" + enc("elsewhere:x")), 404, { error: 'unknown host "elsewhere" (not in config.remotes)' });
    const down = await expectReply(call("POST", "/api/agents/" + enc("lantern:x") + "/resume", {}), 502);
    expect(down.error).toStartWith("ssh lantern:");
    await expectReply(call("GET", "/api/agents/nobody"), 404, { error: 'no local agent "nobody"' });
    await expectReply(call("GET", "/api/agents/" + enc("annex:nobody")), 404, { error: 'no agent matches "nobody"' });
    // The local machine's own name addresses local agents.
    expect((await read("/api/agents/" + enc("motel:keeper-log"))).name).toBe("keeper-log");
  });

  test("detail carries capabilities, runtime and the am detail fields on every agent", async () => {
    for (const item of (await read("/api/agents")).rows) {
      const detail = await read("/api/agents/" + enc(item.host ? `${item.host}:${item.name}` : item.name));
      const native = item.provider !== "antigravity";
      expect(detail.capabilities).toEqual({
        remoteControl: native, quota: native, approvalRelay: native, interruptByReceipt: native,
        handoff: native, move: native, rename: native, subagents: native, attachments: native,
      });
      expect(detail).toMatchObject({ messageReceipts: true, terminalAttach: 1, permissionRequests: native, interruptByReceipt: native });
      expect(Object.keys(detail.runtime).sort()).toEqual(["effort", "effortSource", "model", "modelSource"]);
      expect(detail.model === null || typeof detail.model === "string").toBe(true);
      if (item.provider !== "claude") expect(detail.panePrompt).toBeNull();
    }
    expect((await read("/api/agents/fog-signal")).pendingPermissions).toBe(1);
    expect((await read("/api/agents/old-lens")).pane).toBeNull();
  });

  test("resume: stopped → starting → idle with fleet events; live is a no-op; a missing directory is a 409", async () => {
    const controller = new AbortController();
    const stream = await fetch(server.url + "/api/events", { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` }, signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    await expectReply(call("POST", "/api/agents/old-lens/resume", {}), 200, { ok: true });
    expect((await row("old-lens")).status).toBe("starting");
    await statusIs("old-lens", "idle");
    let text = "";
    const decoder = new TextDecoder();
    const deadline = Date.now() + 3000;
    while (!text.includes('"status":"idle"') && Date.now() < deadline) text += decoder.decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain('"agent":"old-lens","status":"starting"');
    expect(text).toContain('"agent":"old-lens","status":"idle"');
    await expectReply(call("POST", "/api/agents/keeper-log/resume", {}), 200, { ok: true });
    expect((await row("keeper-log")).status).toBe("idle");
    await expectReply(call("POST", "/api/agents/ghost-pier/resume", {}), 409, { error: "agent directory no longer exists: /home/keeper/.agent-manager/worktrees/lighthouse/ghost-pier" });
    await expectReply(call("POST", "/api/agents/nobody/resume", {}), 404, { error: 'no local agent "nobody"' });
  });

  test("restart: refused fields, the locked agent, then starting → idle; the pinned agent comes back working", async () => {
    await expectReply(call("POST", "/api/agents/keeper-log/restart", { ifIdle: true }), 400, { error: "ifIdle is not supported; use `am stop --if-idle`" });
    await expectReply(call("POST", "/api/agents/keeper-log/restart", { model: "x" }), 400, { error: "model is not supported" });
    await expectReply(call("POST", "/api/agents/slipway/restart", {}), 409, { error: 'agent "slipway" is being stopped, removed, renamed, or restarted — retry restart' });
    await expectReply(call("POST", "/api/agents/keeper-log/restart", {}), 200, { ok: true });
    expect((await row("keeper-log")).status).toBe("starting");
    await statusIs("keeper-log", "idle");
    await expectReply(call("POST", "/api/agents/harbor-lights/restart", {}), 200, { ok: true });
    await statusIs("harbor-lights", "working");
  });

  test("interrupt: body checks, no_session for a stopped agent, waiting → idle, pinned stays working", async () => {
    await expectReply(call("POST", "/api/agents/fold-line/interrupt", { messageId: "x" }), 400, { error: "messageId is not supported" });
    await expectReply(call("POST", "/api/agents/fold-line/interrupt", { text: 3 }), 400, { error: "text must be a string" });
    await expectReply(call("POST", "/api/agents/old-lens/interrupt", {}), 409, { reason: "no_session" });
    await expectReply(call("POST", "/api/agents/fold-line/interrupt", {}), 200, { ok: true });
    expect((await row("fold-line")).status).toBe("idle");
    await expectReply(call("POST", "/api/agents/" + enc("annex:kelp-forest") + "/interrupt", {}), 200, { ok: true });
    expect((await row("kelp-forest", "annex")).status).toBe("idle");
    await expectReply(call("POST", "/api/agents/harbor-lights/interrupt", {}), 200, { ok: true });
    expect((await row("harbor-lights")).status).toBe("working");
  });

  test("stop: local prefix and alias matching, 404 for every error, exact on remotes", async () => {
    await expectReply(call("POST", "/api/agents/keeper-log/stop", { ifIdle: true }), 400);
    // Quirk: a unique prefix stops the agent it names.
    await expectReply(call("POST", "/api/agents/errand/stop", {}), 200, { ok: true });
    expect(await row("errand-runner")).toMatchObject({ status: "exited", statusReason: "stopped by operator" });
    await expectReply(call("POST", "/api/agents/o/stop", {}), 404, { error: '"o" is ambiguous: old-lens, origami-docs' });
    await expectReply(call("POST", "/api/agents/nobody/stop", {}), 404, { error: 'no agent matches "nobody"' });
    await expectReply(call("POST", "/api/agents/slipway/stop", {}), 404, { error: 'agent "slipway" is being stopped, removed, renamed, or restarted — retry' });
    await expectReply(call("POST", "/api/agents/" + enc("annex:kelp") + "/stop", {}), 404, { error: 'no agent matches "kelp"' });
    await expectReply(call("POST", "/api/agents/" + enc("annex:kelp-forest") + "/stop", {}), 200, { ok: true });
    expect((await row("kelp-forest", "annex")).status).toBe("exited");
    // Stopping twice is fine.
    await expectReply(call("POST", "/api/agents/errand-runner/stop", {}), 200, { ok: true });
  });

  test("remove: the row and its queue go, a second call is 404, the locked agent gives a bare 500", async () => {
    await expectReply(call("DELETE", "/api/agents/slipway"), 500, { error: "request failed" });
    await expectReply(call("DELETE", "/api/agents/tide-pilot"), 200, { ok: true });
    expect(await row("tide-pilot")).toBeUndefined();
    await expectReply(call("DELETE", "/api/agents/tide-pilot"), 404, { error: 'no local agent "tide-pilot"' });
    await expectReply(call("GET", "/api/agents/tide-pilot"), 404);
    await expectReply(call("DELETE", "/api/agents/" + enc("annex:sandbar")), 200, { ok: true });
    expect(await row("sandbar", "annex")).toBeUndefined();
  });

  test("rename: validation, reserved and taken names, alias kept, remote reply carries the key", async () => {
    await expectReply(call("POST", "/api/agents/keeper-log/rename", { name: "bad name" }), 400, { error: "valid name required (1–64 characters)" });
    await expectReply(call("POST", "/api/agents/keeper-log/rename", { name: "x".repeat(65) }), 400);
    await expectReply(call("POST", "/api/agents/" + enc("annex:sandbar") + "/rename", {}), 400, { error: "Use a name of 1–64 letters, numbers, dashes or underscores" });
    await expectReply(call("POST", "/api/agents/nobody/rename", { name: "x" }), 404, { error: "agent not found" });
    await expectReply(call("POST", "/api/agents/keeper-log/rename", { name: "concierge" }), 409);
    await expectReply(call("POST", "/api/agents/concierge/rename", { name: "front-desk" }), 409);
    await expectReply(call("POST", "/api/agents/keeper-log/rename", { name: "drift-net" }), 409, { error: 'agent name "drift-net" is already used by agent' });
    await expectReply(call("POST", "/api/agents/night-watch/rename", { name: "day-watch" }), 409);
    await expectReply(call("POST", "/api/agents/slipway/rename", { name: "dock" }), 409);
    await expectReply(call("POST", "/api/agents/keeper-log/rename", { name: "keeper-log" }), 200, { ok: true, oldName: "keeper-log", name: "keeper-log", live: true });
    await expectReply(call("POST", "/api/agents/keeper-log/rename", { name: "logbook" }), 200, { ok: true, oldName: "keeper-log", name: "logbook", live: true });
    expect(await row("logbook")).toMatchObject({ status: "idle", aliases: ["keeper-log"] });
    await expectReply(call("GET", "/api/agents/keeper-log"), 404);
    // The old name is now an alias: taken for new agents, and local stop still reaches it.
    await expectReply(call("POST", "/api/agents/drift-net/rename", { name: "keeper-log" }), 409, { error: 'agent name "keeper-log" is already used by alias for "logbook"' });
    await expectReply(call("POST", "/api/agents/keeper-log/stop", {}), 200);
    expect((await row("logbook")).status).toBe("exited");
    await expectReply(call("POST", "/api/agents/" + enc("annex:sandbar") + "/rename", { name: "shoal" }), 200, { ok: true, name: "shoal", key: "annex:shoal" });
  });

  test("move: validation order, then the row changes host and restarts", async () => {
    const move = (key: string, body: unknown) => call("POST", `/api/agents/${enc(key)}/move`, body);
    await expectReply(move("keeper-log", {}), 400, { error: "destination host required" });
    await expectReply(move("keeper-log", { host: "elsewhere" }), 404, { error: "unknown destination host" });
    await expectReply(move("keeper-log", { host: "local" }), 400, { error: "Move between this server and one configured remote host" });
    await expectReply(move("annex:kelp-forest", { host: "lantern" }), 400, { error: "Move between this server and one configured remote host" });
    await expectReply(move("keeper-log", { host: "annex", dir: "relative" }), 400, { error: "destination directory must be an absolute path" });
    await expectReply(move("nobody", { host: "annex" }), 404, { error: "agent not found" });
    await expectReply(move("slipway", { host: "annex" }), 409);
    expect((await expectReply(move("keeper-log", { host: "lantern" }), 409)).error).toStartWith("ssh lantern:");
    const moved = await expectReply(move("keeper-log", { host: "annex", dir: "/srv/lighthouse" }), 200, { ok: true, key: "annex:keeper-log" });
    expect(typeof moved.message).toBe("string");
    expect(await row("keeper-log")).toBeUndefined();
    expect(await row("keeper-log", "annex")).toMatchObject({ dir: "/srv/lighthouse", status: "starting" });
    await statusIs("keeper-log", "idle", "annex");
    expect((await read("/api/agents/" + enc("annex:keeper-log") + "/transcript")).entries.length).toBeGreaterThan(0);
    await expectReply(move("annex:keeper-log", { host: "motel" }), 200, { ok: true, key: "keeper-log" });
    await statusIs("keeper-log", "idle");
  });

  test("model: body validation, the createdAt+status precondition, catalog checks, applied values", async () => {
    const detail = await read("/api/agents/fold-line");
    const model = (body: unknown, key = "fold-line") => call("POST", `/api/agents/${enc(key)}/model`, body);
    const base = { createdAt: detail.createdAt, status: detail.status };
    await expectReply(model([]), 400, { error: "JSON object required" });
    await expectReply(model({ ...base, model: null, extra: 1 }), 400, { error: "extra is not supported" });
    await expectReply(model(base), 400, { error: "model is required" });
    await expectReply(model({ model: null, status: "idle" }), 400, { error: "createdAt is required" });
    await expectReply(model({ ...base, model: null, status: "exited" }), 400, { error: "status must identify a running agent" });
    await expectReply(model({ ...base, model: 5 }), 400, { error: "model must be a string or null" });
    await expectReply(model({ ...base, model: "-x" }), 400, { error: "model is invalid" });
    await expectReply(model({ ...base, model: null, effort: " high" }), 400, { error: "effort is invalid" });
    await expectReply(model({ ...base, model: null }, "nobody"), 404);
    // The dialog opened while it was waiting; it has moved on since.
    await expectReply(model({ ...base, status: "idle", model: null }), 409, { error: 'agent "fold-line" changed or stopped since it was selected — refresh and try again' });
    const unknown = await expectReply(model({ ...base, model: "gpt-9" }), 400);
    expect(unknown.error).toStartWith('unknown codex model "gpt-9" — known models: gpt-5.2-codex');
    await expectReply(model({ ...base, model: "gpt-5.2-codex", effort: "ultra" }), 400);
    const locked = await read("/api/agents/slipway");
    await expectReply(model({ createdAt: locked.createdAt, status: locked.status, model: null }, "slipway"), 409);
    await expectReply(model({ ...base, model: "gpt-5.2", effort: "low" }), 200, { ok: true, model: "gpt-5.2", effort: "low" });
    expect(await row("fold-line")).toMatchObject({ model: "gpt-5.2", effort: "low", status: "starting" });
    await statusIs("fold-line", "idle");
    // Claude's catalog is not exhaustive: an unlisted model is accepted; omitting effort keeps it.
    const keeper = await read("/api/agents/harbor-lights");
    await expectReply(model({ createdAt: keeper.createdAt, status: "working", model: "claude-custom-1" }, "harbor-lights"), 200, { ok: true, model: "claude-custom-1", effort: "high" });
    await statusIs("harbor-lights", "working");
    // Remote: the request is echoed back.
    const kelp = await read("/api/agents/" + enc("annex:kelp-forest"));
    await expectReply(model({ createdAt: kelp.createdAt, status: kelp.status, model: null }, "annex:kelp-forest"), 200, { ok: true, model: null });
  });

  test("models and roles catalogs", async () => {
    const local = await read("/api/models");
    expect(local.map((catalog: { provider: string }) => catalog.provider)).toEqual(["claude", "codex", "antigravity"]);
    for (const catalog of local) {
      expect(Object.keys(catalog).sort()).toEqual(["efforts", "effortsExhaustive", "models", "modelsExhaustive", "provider"]);
      for (const item of catalog.models) expect(Array.isArray(item.efforts)).toBe(true);
    }
    expect(local.find((catalog: { provider: string }) => catalog.provider === "claude").modelsExhaustive).toBe(false);
    const annex = await read("/api/models?host=annex");
    expect(annex.map((catalog: { provider: string }) => catalog.provider)).toEqual(["claude", "codex"]);
    expect(annex[0].effortsExhaustive).toBe(false);
    expect(await read("/api/models?host=motel")).toEqual(local);
    await expectReply(call("GET", "/api/models?host=bad%20host"), 400, { error: 'invalid host "bad host"' });
    await expectReply(call("GET", "/api/models?host=elsewhere"), 404);
    await expectReply(call("GET", "/api/models?host=lantern"), 502);
    const { roles } = await read("/api/roles");
    expect(roles.map((role: { name: string }) => role.name)).toEqual(["caretaker", "concierge", "docs-writer", "reviewer"]);
    expect(roles.filter((role: { builtIn?: boolean }) => role.builtIn).length).toBe(2);
    for (const role of roles) expect(typeof role.instructions).toBe("string");
  });

  test("handoff: validation, unsupported sources, and silent name suffixing", async () => {
    const handoff = (key: string, body: unknown) => call("POST", `/api/agents/${enc(key)}/handoff`, body);
    await expectReply(handoff("harbor-lights", { to: "antigravity" }), 400, { error: "antigravity handoff is unsupported" });
    await expectReply(handoff("harbor-lights", {}), 400, { error: "to must be claude or codex" });
    await expectReply(handoff("harbor-lights", { to: "codex", newName: "bad name" }), 400, { error: "newName must be 1–64 letters, numbers, dashes or underscores" });
    await expectReply(handoff("harbor-lights", { to: "codex", full: "yes" }), 400, { error: "full must be a boolean" });
    await expectReply(handoff("nobody", { to: "codex" }), 404);
    await expectReply(handoff("night-watch", { to: "codex" }), 409, { error: "antigravity handoff is unsupported" });
    await expectReply(handoff("ghost-pier", { to: "codex" }), 409, { error: 'agent "ghost-pier" has an empty transcript — nothing to hand off' });
    await expectReply(handoff("harbor-lights", { to: "codex", full: true }), 201, { ok: true, name: "harbor-lights-codex", target: "codex", key: "harbor-lights-codex" });
    await expectReply(handoff("harbor-lights", { to: "codex" }), 201, { name: "harbor-lights-codex2", key: "harbor-lights-codex2" });
    // A taken newName is suffixed, not refused.
    await expectReply(handoff("keeper-log", { to: "codex", newName: "drift-net" }), 201, { name: "drift-net2" });
    const created = await row("harbor-lights-codex");
    expect(created).toMatchObject({ provider: "codex", repoRoot: "/home/keeper/code/lighthouse", worktreeBranch: "am/harbor-lights-codex" });
    await statusIs("harbor-lights-codex", "idle");
    const entries = (await read("/api/agents/harbor-lights-codex/transcript")).entries;
    expect(entries.map((entry: { kind: string }) => entry.kind)).toEqual(["user", "assistant"]);
    expect(entries[0].text).toContain('taking over work from the agent "harbor-lights"');
    await expectReply(handoff("annex:sandbar", { to: "codex" }), 201, { name: "sandbar-codex", key: "annex:sandbar-codex" });
  });

  test("create: validation order, newCommand refusals, local vs remote catalog statuses", async () => {
    const create = (body: unknown) => call("POST", "/api/agents", body);
    await expectReply(create({ task: "x" }), 400, { error: "name required" });
    await expectReply(create({ name: "a", model: 3 }), 400, { error: "model must be a string" });
    await expectReply(create({ name: "a", provider: "gemini" }), 400, { error: "provider must be claude, codex, or antigravity" });
    await expectReply(create({ name: "a", codex: "yes" }), 400, { error: "codex must be a boolean" });
    await expectReply(create({ name: "a", provider: "claude", codex: true }), 400, { error: "contradictory provider and codex selection" });
    await expectReply(create({ name: "a", task: 5 }), 400, { error: "task must be a string" });
    await expectReply(create({ name: "a", host: "bad host" }), 400, { error: "invalid host" });
    await expectReply(create({ name: "a", host: "elsewhere" }), 404, { error: 'unknown host "elsewhere" (not in config.remotes)' });
    await expectReply(create({ name: "bad name", provider: "codex" }), 409, { error: "agent name must be alphanumeric with dashes/underscores" });
    await expectReply(create({ name: "concierge", provider: "claude" }), 409);
    await expectReply(create({ name: "a", provider: "claude", role: "concierge" }), 409);
    await expectReply(create({ name: "keeper-log", provider: "claude" }), 409, { error: "agent \"keeper-log\" already exists — restart it with `am resume keeper-log`" });
    await expectReply(create({ name: "a", provider: "claude", role: "pirate" }), 409, { error: "unknown role \"pirate\" — list roles with `am role list`" });
    await expectReply(create({ name: "a", provider: "codex", model: "gpt-9" }), 409);
    await expectReply(create({ name: "a", provider: "codex", model: "gpt-9", host: "annex" }), 400);
    await expectReply(create({ name: "a", provider: "codex", dir: "/nowhere" }), 409, { error: "directory does not exist: /nowhere" });
    await expectReply(create({ name: "a", host: "annex", remoteDir: "relative" }), 400, { error: "remoteDir must be an absolute path" });
    await expectReply(create({ name: "a", host: "annex", dir: "/srv/x" }), 400, { error: "dir /srv/x is not under /home/keeper — pass remoteDir for annex" });
    expect((await expectReply(create({ name: "a", host: "lantern", dir: "/home/keeper" }), 502)).error).toStartWith("ssh lantern:");

    await expectReply(create({ name: "chart-room", task: "Draw the harbour chart legend", provider: "claude", dir: "/home/keeper/code/lighthouse", role: "reviewer", model: "claude-opus-4-5", effort: "high" }), 201, { ok: true, name: "chart-room" });
    expect(await row("chart-room")).toMatchObject({
      status: "starting", provider: "claude", dir: "/home/keeper/.agent-manager/worktrees/lighthouse/chart-room", repoRoot: "/home/keeper/code/lighthouse",
      worktreeBranch: "am/chart-room", role: "reviewer", model: "claude-opus-4-5", effort: "high",
    });
    await statusIs("chart-room", "working");
    await statusIs("chart-room", "idle");
    const entries = (await read("/api/agents/chart-room/transcript")).entries;
    expect(entries.map((entry: { kind: string; text: string }) => [entry.kind, entry.kind === "user" ? entry.text : "reply"])).toEqual([["user", "Draw the harbour chart legend"], ["assistant", "reply"]]);
    await expectReply(create({ name: "chart-room", provider: "claude" }), 409);
    await expectReply(create({ name: "tide-gauge", task: "Calibrate", provider: "codex", host: "annex", remoteDir: "/srv/tide-tables" }), 201, { ok: true, name: "tide-gauge", host: "annex" });
    expect(await row("tide-gauge", "annex")).toMatchObject({ dir: "/srv/tide-tables" });
    await statusIs("tide-gauge", "idle", "annex");
    await expectReply(create({ name: "home-run", provider: "codex", host: "local", dir: "~" }), 201, { ok: true, name: "home-run" });
    expect(await row("home-run")).toMatchObject({ dir: "/home/keeper" });
    await statusIs("home-run", "idle");
  });

  test("concierge ensure: returns the key, recreates a removed concierge", async () => {
    await expectReply(call("POST", "/api/concierge", {}), 200, { key: "concierge" });
    await expectReply(call("DELETE", "/api/agents/concierge"), 200);
    await expectReply(call("POST", "/api/concierge", {}), 200, { key: "concierge" });
    expect(await row("concierge")).toMatchObject({ role: "concierge", status: "starting" });
    await statusIs("concierge", "idle");
  });

  test("permissions: listing, answer validation, single use, expiry; the agent goes back to working", async () => {
    const { fogPermission, fogExpiredPermission, sandbarPermission } = FIXTURE_IDS;
    const { requests } = await read("/api/agents/fog-signal/permissions");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ id: fogPermission, provider: "codex", tool: "exec_command", expiresAt: null });
    expect(requests[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(requests[0].options.map((option: { id: string }) => option.id)).toEqual(["accept", "acceptForSession", "decline"]);
    expect(Object.keys(requests[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "input", "options", "provider", "summary", "tool"]);
    expect(await read("/api/agents/keeper-log/permissions")).toEqual({ requests: [] });
    const answer = (key: string, id: string, body: unknown) => call("POST", `/api/agents/${enc(key)}/permissions/${id}`, body);
    await expectReply(answer("fog-signal", fogPermission, { optionId: "bad option" }), 400, { error: "optionId must be one of the request's option ids" });
    await expectReply(answer("fog-signal", "01NOTAREQUEST", { optionId: "accept" }), 404, { error: 'no permission request "01NOTAREQUEST" for agent "fog-signal"' });
    await expectReply(answer("keeper-log", fogPermission, { optionId: "accept" }), 404);
    await expectReply(answer("fog-signal", fogPermission, { optionId: "allow" }), 400, { error: `unknown permission option "allow" for request ${fogPermission}` });
    await expectReply(answer("fog-signal", fogExpiredPermission, { optionId: "accept" }), 409, { reason: "expired" });
    await expectReply(answer("fog-signal", fogPermission, { optionId: "accept" }), 200, { ok: true, id: fogPermission, optionId: "accept" });
    await expectReply(answer("fog-signal", fogPermission, { optionId: "accept" }), 409, { error: `permission request ${fogPermission} is already resolved`, reason: "already_resolved" });
    expect(await row("fog-signal")).toMatchObject({ status: "working" });
    expect((await read("/api/agents/fog-signal")).pendingPermissions).toBe(0);
    const sandbar = (await read("/api/agents/" + enc("annex:sandbar") + "/permissions")).requests[0];
    expect(sandbar).toMatchObject({ id: sandbarPermission, tool: "AskUserQuestion", options: [{ id: "answer-0" }, { id: "answer-1" }, { id: "deny", label: "Skip" }] });
    expect(sandbar.input.questions[0].options).toHaveLength(2);
    await expectReply(answer("annex:sandbar", "not-a-ulid", { optionId: "deny" }), 404);
    await expectReply(answer("annex:sandbar", sandbarPermission, { optionId: "answer-1" }), 200, { ok: true });
    expect((await row("sandbar", "annex")).status).toBe("working");
  });

  test("pane prompt: origami-docs question, validation, refusals, single use", async () => {
    const { panePrompt } = await read("/api/agents/origami-docs");
    expect(panePrompt).toMatchObject({ id: FIXTURE_IDS.origamiPrompt, kind: "question", selected: "1" });
    expect(panePrompt.options.map((option: { id: string; other?: boolean }) => [option.id, !!option.other])).toEqual([["1", false], ["2", false], ["3", false], ["4", true]]);
    expect(typeof panePrompt.raw).toBe("string");
    expect((await read("/api/agents/keeper-log")).panePrompt).toBeNull();
    const answer = (body: unknown, key = "origami-docs") => call("POST", `/api/agents/${key}/prompt`, body);
    const id = panePrompt.id;
    await expectReply(answer({ id: "nothex", optionId: "1" }), 400, { error: "Invalid prompt answer" });
    await expectReply(answer({ id, optionId: "4", text: "tab\there" }), 400, { error: "Invalid prompt answer" });
    await expectReply(answer({ id, optionId: "1" }, "nobody"), 404);
    await expectReply(answer({ id, optionId: "1" }, "keeper-log"), 409, { ok: false, error: "Prompt changed or was already answered; refresh and try again" });
    await expectReply(answer({ id: "0".repeat(32), optionId: "1" }), 409, { ok: false });
    await expectReply(answer({ id, optionId: "7" }), 409, { ok: false, error: "Invalid prompt option" });
    await expectReply(answer({ id, optionId: "4" }), 409, { ok: false, error: "Other requires a single line of text (maximum 2000 characters)" });
    await expectReply(answer({ id, optionId: "4", text: "line\u2028break" }), 409, { ok: false, error: "Other requires a single line of text (maximum 2000 characters)" });
    await expectReply(answer({ id, optionId: "2", text: "hi" }), 409, { ok: false, error: "Text is only supported for Other" });
    await expectReply(answer({ id, optionId: "4", text: "Teachers running a workshop" }), 200, { ok: true });
    await expectReply(answer({ id, optionId: "1" }), 409, { ok: false, error: "Prompt changed or was already answered; refresh and try again" });
    expect((await read("/api/agents/origami-docs")).panePrompt).toBeNull();
    expect((await read("/api/agents/origami-docs/transcript")).entries.at(-1)).toMatchObject({ kind: "user", text: "Teachers running a workshop" });
    expect((await row("origami-docs")).status).toBe("working");
  });

  test("files: type, size, emptiness and magic-byte checks; antigravity refused; uploads logged by size", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const upload = (key: string, bytes: Uint8Array, type: string) => call("POST", `/api/agents/${enc(key)}/files`, bytes, { "content-type": type });
    const saved = await expectReply(upload("harbor-lights", png, "image/png"), 201);
    expect(saved.path).toMatch(/^\/home\/keeper\/\.agent-manager\/inbox\/harbor-lights\/paste-\d+-[0-9a-f]{8}\.png$/);
    expect((await expectReply(upload("harbor-lights", png, "image/png"), 201)).path).not.toBe(saved.path);
    await expectReply(upload("harbor-lights", png, "text/plain"), 415, { error: "Only PNG, JPEG, GIF and WebP images can be attached" });
    await expectReply(upload("harbor-lights", new Uint8Array(), "image/png"), 400, { error: "Image is empty" });
    await expectReply(upload("harbor-lights", png, "image/jpeg"), 415, { error: "File is not a valid image/jpeg image" });
    await expectReply(upload("harbor-lights", png, "IMAGE/PNG; charset=binary"), 201);
    await expectReply(upload("night-watch", png, "image/png"), 409, { error: "Antigravity image attachments are unsupported" });
    await expectReply(upload("nobody", png, "text/plain"), 404);
    // Remote: the image is checked before the agent.
    await expectReply(upload("annex:nobody", png, "text/plain"), 415);
    expect((await expectReply(upload("annex:sandbar", png, "image/png"), 201)).path).toContain("/inbox/sandbar/");
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(png);
    await expectReply(upload("harbor-lights", big, "image/png"), 413, { error: "Image is larger than 10 MB" });
    const log = await read("/__fixture/requests");
    expect(log[0]).toEqual({ method: "POST", path: "/api/agents/harbor-lights/files", body: { contentType: "image/png", bytes: png.length } });
    expect(log.at(-1).body).toEqual({ contentType: "image/png", bytes: big.length });
  });

  test("JSON bodies over 256 KiB are refused like am", async () => {
    await expectReply(call("POST", "/api/search", { query: "x".repeat(300 * 1024) }), 413, { error: "request body too large" });
  });

  test("subagents: harbor-lights has two running and one finished, each with a transcript", async () => {
    const { records } = await read("/api/agents/harbor-lights/subagents");
    expect(records).toHaveLength(3);
    expect(records.filter((record: { endedAt?: string }) => !record.endedAt)).toHaveLength(2);
    const finished = records.find((record: { endedAt?: string }) => record.endedAt);
    expect(finished).toMatchObject({ id: FIXTURE_IDS.subagents.audit, type: "general-purpose", tokens: { steps: 14 } });
    expect((await row("harbor-lights")).subagents).toMatchObject({ active: 2 });
    const done = await read(`/api/agents/harbor-lights/transcript?subagent=${finished.id}`);
    expect(done).toMatchObject({ provider: "claude", status: "exited" });
    expect(done.total).toBe(done.entries.length);
    expect((await read(`/api/agents/harbor-lights/transcript?subagent=${FIXTURE_IDS.subagents.explore}`)).status).toBe("working");
    await expectReply(call("GET", "/api/agents/harbor-lights/transcript?subagent=bad%20id"), 400, { error: "invalid subagent id" });
    await expectReply(call("GET", "/api/agents/harbor-lights/transcript?subagent=nosuch"), 409);
    expect(await read("/api/agents/keeper-log/subagents")).toEqual({ records: [] });
    await call("POST", "/api/agents/harbor-lights/stop", {});
    const stale = (await read("/api/agents/harbor-lights/subagents")).records;
    expect(stale.filter((record: { stale?: boolean }) => record.stale)).toHaveLength(2);
  });

  test("per-agent usage follows AgentTokenReport", async () => {
    const report = await read("/api/agents/harbor-lights/usage");
    expect(Object.keys(report).sort()).toEqual(["anomalies", "byRole", "combined", "main", "model", "name", "provider", "status", "subagentTotals", "subagents", "tools", "updatedAt", "workflows"]);
    const buckets = ["activeTokens", "budgetTokens", "cacheCreationTokens", "cacheReadTokens", "costUSD", "inputTokens", "outputTokens", "steps", "thinkingTokens", "totalTokens"];
    expect(Object.keys(report.combined).sort()).toEqual(buckets);
    const { main, subagentTotals, combined } = report;
    expect(combined.activeTokens).toBe(main.activeTokens + subagentTotals.activeTokens);
    expect(main.activeTokens).toBe(main.inputTokens + main.cacheCreationTokens + main.outputTokens);
    expect(main.totalTokens).toBe(main.activeTokens + main.cacheReadTokens);
    expect(report.subagents).toHaveLength(3);
    expect(report.subagents.map((item: { status: string }) => item.status).sort()).toEqual(["finished", "running", "running"]);
    expect(report.anomalies[0]).toMatchObject({ kind: "cache-bust", agent: "harbor-lights" });
    // Unpriced model: no costUSD.
    expect((await read("/api/agents/night-watch/usage")).combined.costUSD).toBeUndefined();
    expect((await read("/api/agents/" + enc("annex:kelp-forest") + "/usage")).name).toBe("kelp-forest");
    await expectReply(call("GET", "/api/agents/nobody/usage"), 404);
    expect(await read("/api/agents/harbor-lights/usage")).toEqual(report);
  });

  test("fleet usage: shape, quota windows, filters, and 404 for any failure", async () => {
    const full = await read("/api/usage");
    expect(full.quota.map((item: { provider: string }) => item.provider)).toEqual(["claude", "codex"]);
    for (const provider of full.quota) {
      for (const window of provider.windows) {
        expect(typeof window.label).toBe("string");
        expect(window.utilization).toBeGreaterThanOrEqual(0);
        expect(window.utilization).toBeLessThanOrEqual(100);
        expect(Date.parse(window.resetsAt)).toBeGreaterThan(Date.now());
      }
    }
    expect(full.quota.flatMap((item: { windows: { utilization: number }[] }) => item.windows.map((window) => window.utilization)).some((value: number) => value >= 90)).toBe(true);
    const { tokens } = full;
    expect(Object.keys(tokens).sort()).toEqual(["agents", "anomalies", "byRole", "generatedAt", "host", "tools", "totals", "workflows"]);
    expect(tokens.agents.every((agent: { name: string }) => !["kelp-forest", "sandbar"].includes(agent.name))).toBe(true);
    expect(tokens.totals.combined.activeTokens).toBe(tokens.agents.reduce((sum: number, agent: { combined: { activeTokens: number } }) => sum + agent.combined.activeTokens, 0));
    expect((await read("/api/usage?quota=0")).quota).toBeUndefined();
    const codex = await read("/api/usage?provider=codex&quota=0");
    expect(codex.tokens.agents.every((agent: { provider: string }) => agent.provider === "codex")).toBe(true);
    // `agent` resolves like local stop (prefix and alias) and then ignores `provider`.
    const harbor = await read("/api/usage?agent=%20harbor%20&provider=codex&quota=0");
    expect(harbor.tokens.agents.map((agent: { name: string }) => agent.name)).toEqual(["harbor-lights"]);
    await expectReply(call("GET", "/api/usage?provider=gemini"), 400, { error: 'unknown provider "gemini"' });
    await expectReply(call("GET", "/api/usage?agent=bad%20name"), 400, { error: 'invalid agent name "bad name"' });
    await expectReply(call("GET", "/api/usage?agent=nobody"), 404, { error: 'no agent matches "nobody"' });
  });

  test("usage summary: ranges, filters, deterministic numbers, the inventory's shape", async () => {
    const strip = (value: any) => ({ ...value, summary: { ...value.summary, generatedAt: "" }, quota: undefined });
    const week = await read("/api/usage/summary");
    expect(strip(await read("/api/usage/summary?range=7"))).toEqual(strip(week));
    const { summary } = week;
    expect(Object.keys(summary).sort()).toEqual(["agents", "byModel", "byRepo", "classes", "days", "filters", "generatedAt", "host", "indexing", "totals", "unattributed"]);
    expect(summary.days).toHaveLength(30);
    expect(summary.days.every((day: string) => /^\d{4}-\d\d-\d\d$/.test(day))).toBe(true);
    expect(Object.keys(summary.classes).sort()).toEqual(["cacheRead", "cacheWrite1h", "cacheWrite5m", "input", "output"]);
    for (const amount of [summary.totals.today, summary.totals.last7, summary.totals.last30]) {
      expect(Object.keys(amount).sort()).toEqual(["activeTokens", "cacheReadTokens", "calls", "costUSD", "unpricedActiveTokens"]);
    }
    expect(summary.totals.last30.costUSD).toBeGreaterThan(summary.totals.last7.costUSD);
    expect(summary.byModel.some((item: { priced: boolean }) => !item.priced)).toBe(true);
    expect(summary.byModel.length).toBeGreaterThanOrEqual(4);
    expect(summary.filters.repos).toEqual(expect.arrayContaining(["lighthouse", "paper-crane", "tide-tables", "~"]));
    expect(summary.filters.providers).toEqual(["antigravity", "claude", "codex"]);
    const agent = summary.agents.find((item: { name: string }) => item.name === "harbor-lights");
    expect(Object.keys(agent).sort()).toEqual(["cacheHitRate", "cacheWriteShare", "context", "dailyActiveTokens", "dailyCostUSD", "live", "mainCostUSD", "model", "name", "provider", "range", "repo", "status", "subagentCostUSD", "subagents", "today"].sort());
    expect(agent.dailyCostUSD).toHaveLength(30);
    expect(agent.subagentCostUSD).toBeGreaterThan(0);
    expect(agent.context).toMatchObject({ window: 200000 });
    expect(summary.unattributed.dailyCostUSD).toHaveLength(30);
    const month = (await read("/api/usage/summary?range=30&quota=0")).summary;
    expect(month.agents.find((item: { name: string }) => item.name === "beacon-audit")).toMatchObject({ status: "removed", live: false });
    expect(month.agents.length).toBeGreaterThan(summary.agents.length - 1);
    const lighthouse = (await read("/api/usage/summary?range=30&repo=lighthouse&quota=0")).summary;
    expect(lighthouse.agents.every((item: { repo?: string }) => item.repo === "lighthouse")).toBe(true);
    expect(lighthouse.filters).toEqual(month.filters);
    const today = (await read("/api/usage/summary?range=1&provider=codex&quota=0")).summary;
    expect(today.agents.every((item: { provider: string }) => item.provider === "codex")).toBe(true);
    expect((await read("/api/usage/summary?quota=0")).quota).toBeUndefined();
    expect(week.quota).toHaveLength(2);
    for (const range of ["2", "x", "", "-7"]) {
      await expectReply(call("GET", `/api/usage/summary?range=${range}`), 400, { error: `invalid range "${range}" (expected 1, 7, or 30)` });
    }
    await expectReply(call("GET", "/api/usage/summary?provider=gemini"), 400);
    await call("DELETE", "/api/agents/keeper-log");
    const after = (await read("/api/usage/summary?range=30&quota=0")).summary;
    expect(after.agents.find((item: { name: string }) => item.name === "keeper-log")).toMatchObject({ status: "removed", live: false });
  });

  test("workspace and diff", async () => {
    const workspace = await read("/api/agents/harbor-lights/workspace");
    expect(workspace).toMatchObject({ available: true, branch: "am/harbor-lights", base: "main", repository: "example/lighthouse", total: 5 });
    expect(workspace.pullRequests).toEqual([{ number: 14, title: expect.any(String), url: "https://github.com/example/lighthouse/pull/14", state: "OPEN", isDraft: true }]);
    expect(workspace.files.map((file: { status: string }) => file.status)).toContain("??");
    expect(Object.keys(workspace.files[0]).sort()).toEqual(["additions", "deletions", "path", "status", "working"]);
    const diff = await read("/api/agents/harbor-lights/diff?path=src%2Fsync%2Fworker.ts");
    expect(diff).toMatchObject({ path: "src/sync/worker.ts", binary: false, truncated: false });
    expect(diff.diff).toContain("@@ ");
    expect(await read("/api/agents/harbor-lights/diff?path=docs%2Fstatus-panel.png")).toEqual({ path: "docs/status-panel.png", diff: "", binary: true, truncated: false });
    await expectReply(call("GET", "/api/agents/harbor-lights/diff"), 400, { error: "file path required" });
    await expectReply(call("GET", "/api/agents/nobody/diff?path=x"), 404, { error: "agent not found" });
    await expectReply(call("GET", "/api/agents/harbor-lights/diff?path=..%2Fetc%2Fpasswd"), 409);
    await expectReply(call("GET", "/api/agents/nobody/workspace"), 404);
    expect(await read("/api/agents/concierge/workspace")).toEqual({ available: false, files: [], total: 0, pullRequests: [] });
    expect((await read("/api/agents/" + enc("annex:kelp-forest") + "/workspace")).repository).toBe("example/tide-tables");
  });

  test("search: validation, substring matches across hosts, partial with the unreachable host", async () => {
    await expectReply(call("POST", "/api/search", { query: " a " }), 400, { error: "Search must contain 2–256 characters" });
    await expectReply(call("POST", "/api/search", { query: "x".repeat(257) }), 400);
    await expectReply(call("POST", "/api/search", {}), 400);
    const result = await expectReply(call("POST", "/api/search", { query: "RETRY-AFTER" }), 200);
    expect(Object.keys(result).sort()).toEqual(["matches", "partial", "unavailable"]);
    expect(result).toMatchObject({ partial: true, unavailable: ["lantern"] });
    const harbor = result.matches.find((match: { name: string }) => match.name === "harbor-lights");
    expect(harbor.host).toBeUndefined();
    expect(harbor.snippets.length).toBeLessThanOrEqual(3);
    for (const snippet of harbor.snippets) {
      expect(["user", "assistant", "tool"]).toContain(snippet.kind);
      expect(snippet.text.toLowerCase()).toContain("retry-after");
      expect(snippet.text.length).toBeLessThanOrEqual(600);
    }
    const remote = (await expectReply(call("POST", "/api/search", { query: "harmonic" }), 200)).matches;
    expect(remote).toEqual([{ name: "kelp-forest", host: "annex", snippets: [expect.objectContaining({ kind: "tool" }), expect.objectContaining({ kind: "assistant" })] }]);
    expect((await expectReply(call("POST", "/api/search", { query: "zzqq-nothing" }), 200)).matches).toEqual([]);
  });

  test("request log: every authorised non-GET with its parsed body, nothing for GETs or unauthorised calls", async () => {
    await call("GET", "/api/agents");
    await call("POST", "/api/agents/keeper-log/resume", {}, {}, null);
    await call("POST", "/api/agents/keeper-log/restart", {});
    await call("POST", "/api/agents/keeper-log/rename", "not json", { "content-type": "application/json" });
    await call("DELETE", "/api/agents/nobody");
    expect(await read("/__fixture/requests")).toEqual([
      { method: "POST", path: "/api/agents/keeper-log/restart", body: {} },
      { method: "POST", path: "/api/agents/keeper-log/rename", body: "not json" },
      { method: "DELETE", path: "/api/agents/nobody", body: null },
    ]);
  });
});
