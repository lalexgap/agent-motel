import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, loadApiToken, createApiToken, type ApiServerHandle } from "../src/server";
import { readAgent, writeAgent } from "../src/state";
import { queueAppend } from "../src/queue";
import { daemonRequest, startDaemonServer } from "../src/daemon";
import { addRole } from "../src/roles";
import { setRemoteRunnersForTests } from "../src/remoteAgents";
import { localHostIdentity } from "../src/config";
import { resetFleetCacheForTests, setFleetFetchForTests } from "../src/fleet";

let home: string;
let server: ApiServerHandle;
const TOKEN = "test-secret-token";

function url(path: string) {
  return server.url + path;
}
function auth(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { Authorization: `Bearer ${TOKEN}`, ...(extra.headers || {}) } };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
  server = startApiServer({ port: 0, hostname: "127.0.0.1", token: TOKEN });
});

afterEach(() => {
  server.stop();
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  delete process.env.AM_API_TOKEN;
});

function seedAgent(name: string, status: "idle" | "working" | "exited" = "idle") {
  const now = new Date().toISOString();
  writeAgent({ name, status, dir: "/tmp", tmuxSession: `agentmgr-${name}`, createdAt: now, updatedAt: now });
}

describe("api auth", () => {
  test("rejects missing token", async () => {
    expect((await fetch(url("/api/health"))).status).toBe(401);
  });

  test("rejects wrong token", async () => {
    const res = await fetch(url("/api/health"), { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  test("accepts the token", async () => {
    const res = await fetch(url("/api/health"), auth());
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
  });

  test("query-param tokens are no longer accepted (they leak into logs)", async () => {
    expect((await fetch(url(`/api/health?token=${TOKEN}`))).status).toBe(401);
  });
});

describe("api only — no static shell", () => {
  test("non-api paths 404 (the PWA is gone)", async () => {
    expect((await fetch(url("/manifest.webmanifest"))).status).toBe(404);
    expect((await fetch(url("/some/deep/link"))).status).toBe(404);
  });

  test("tombstones tear down stranded PWA installs", async () => {
    // The root explains itself (410 Gone) and the service-worker URL serves
    // a self-destructing worker, so installed phones don't cache a raw 404.
    const root = await fetch(url("/"));
    expect(root.status).toBe(410);
    expect(await root.text()).toContain("removed");
    const sw = await fetch(url("/sw.js"));
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain("unregister");
  });
});

describe("agents api", () => {
  test("GET /api/agents merges local rows with queue depth", async () => {
    seedAgent("alpha", "working");
    queueAppend("alpha", "do the thing");
    const res = await fetch(url("/api/agents"), auth());
    const data = (await res.json()) as any;
    const row = data.rows.find((r: any) => r.name === "alpha");
    expect(row.status).toBe("dead"); // no real tmux session in tests
    expect(row.queued).toBe(1);
    expect(data.unreachable).toEqual([]);
  });

  test("GET /api/roles lists built-in and custom definitions", async () => {
    addRole({ name: "changelog-writer", instructions: "Write the changelog." });
    const res = await fetch(url("/api/roles"), auth());
    const data = (await res.json()) as any;
    expect(data.roles.map((role: any) => role.name)).toEqual(["concierge", "changelog-writer"]);
  });

  test("GET /api/summary returns the prioritized fleet report", async () => {
    seedAgent("alpha", "working");
    const res = await fetch(url("/api/summary"), auth());
    const data = (await res.json()) as any;
    expect(data.totalAgents).toBe(1);
    // There is no tmux session in this fixture, so the derived dead status is
    // correctly promoted into the attention section.
    expect(data.attention[0]).toMatchObject({ name: "alpha", status: "dead" });
  });

  test("GET /api/agents/:name returns detail + queue", async () => {
    const now = new Date().toISOString();
    writeAgent({ name: "beta", role: "reviewer", status: "idle", dir: "/tmp", tmuxSession: "agentmgr-beta", createdAt: now, updatedAt: now });
    queueAppend("beta", "hello");
    const res = await fetch(url("/api/agents/beta"), auth());
    const data = (await res.json()) as any;
    expect(data.name).toBe("beta");
    expect(data.role).toBe("reviewer");
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].message).toBe("hello");
    expect(data.pane).toBeNull(); // no live session
    expect(data.statusReason).toBe("tmux session is missing");
    expect(data.statusChangedAt).toBeTruthy();
  });

  test("GET detail 404s for unknown agent", async () => {
    expect((await fetch(url("/api/agents/ghost"), auth())).status).toBe(404);
  });

  test("POST message to an agent with no live session → 409", async () => {
    seedAgent("gamma");
    const res = await fetch(
      url("/api/agents/gamma/messages"),
      auth({ method: "POST", body: JSON.stringify({ text: "hi", mode: "queue" }) }),
    );
    expect(res.status).toBe(409);
  });

  test("POST message without text → 400", async () => {
    seedAgent("delta");
    const res = await fetch(
      url("/api/agents/delta/messages"),
      auth({ method: "POST", body: JSON.stringify({ mode: "queue" }) }),
    );
    expect(res.status).toBe(400);
  });

  test("POST spawn with invalid name → 409", async () => {
    const res = await fetch(url("/api/agents"), auth({ method: "POST", body: JSON.stringify({ name: "bad name!" }) }));
    expect(res.status).toBe(409);
  });

  test("POST spawn with an unknown provider → 400", async () => {
    const res = await fetch(
      url("/api/agents"),
      auth({ method: "POST", body: JSON.stringify({ name: "echo", provider: "gpt" }) }),
    );
    expect(res.status).toBe(400);
  });

  test("POST spawn without name → 400", async () => {
    const res = await fetch(url("/api/agents"), auth({ method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(400);
  });

  test("POST rename migrates an agent identity", async () => {
    seedAgent("before", "exited");
    const res = await fetch(
      url("/api/agents/before/rename"),
      auth({ method: "POST", body: JSON.stringify({ name: "after" }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, oldName: "before", name: "after", live: false });
    expect(readAgent("before")).toBeNull();
    expect(readAgent("after")?.aliases).toContain("before");
  });

  test("DELETE unknown agent → 404", async () => {
    expect((await fetch(url("/api/agents/ghost"), auth({ method: "DELETE" }))).status).toBe(404);
  });

  test("DELETE removes the agent", async () => {
    seedAgent("epsilon", "exited");
    const res = await fetch(url("/api/agents/epsilon"), auth({ method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await fetch(url("/api/agents/epsilon"), auth())).status).toBe(404);
  });

  test("unknown api route → 404", async () => {
    expect((await fetch(url("/api/nonsense"), auth())).status).toBe(404);
  });

  test("GET /api/events proxies authenticated daemon events", async () => {
    const daemon = startDaemonServer();
    try {
      const response = await fetch(url("/api/events"), auth());
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
      await daemonRequest("/event", {
        method: "POST",
        body: JSON.stringify({ agent: "api-agent", event: "idle" }),
      });
      expect(decoder.decode((await reader.read()).value)).toContain('"agent":"api-agent"');
      await reader.cancel();
    } finally {
      daemon.stop();
    }
  });
});

describe("transcript + interrupt api", () => {
  const line = (o: object) => JSON.stringify(o) + "\n";
  const userLine = (text: string) => line({ type: "user", sessionId: "s-1", message: { role: "user", content: text } });
  const toolUse = line({
    type: "assistant",
    sessionId: "s-1",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  });
  const toolResult = line({
    type: "user",
    sessionId: "s-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  });
  const assistantLine = (text: string) =>
    line({ type: "assistant", sessionId: "s-1", message: { role: "assistant", content: [{ type: "text", text }] } });

  function seedWithTranscript(name: string, jsonl: string): string {
    const file = join(home, `${name}.jsonl`);
    writeFileSync(file, jsonl);
    const now = new Date().toISOString();
    writeAgent({
      name, status: "idle", dir: "/tmp", tmuxSession: `agentmgr-${name}`,
      sessionId: "s-1", transcriptPath: file, createdAt: now, updatedAt: now,
    });
    return file;
  }

  async function getTranscript(name: string, query = ""): Promise<any> {
    const res = await fetch(url(`/api/agents/${name}/transcript${query}`), auth());
    expect(res.status).toBe(200);
    return res.json();
  }

  test("returns indexed turns, stable as the file grows; tool output lands at its existing index", async () => {
    const file = seedWithTranscript("tx", userLine("hi") + toolUse);
    const first = await getTranscript("tx");
    expect(first.provider).toBe("claude");
    expect(first.sessionId).toBe("s-1");
    expect(first.status).toBe("dead"); // no tmux session in tests
    expect(first.total).toBe(2);
    expect(first.entries).toEqual([
      { index: 0, kind: "user", text: "hi" },
      { index: 1, kind: "tool", name: "Bash", input: '{"command":"ls"}' },
    ]);

    appendFileSync(file, toolResult + assistantLine("done") + '{"type":"assis'); // partial last line
    const second = await getTranscript("tx", "?after=1");
    expect(second.total).toBe(3);
    expect(second.entries).toEqual([
      { index: 1, kind: "tool", name: "Bash", input: '{"command":"ls"}', output: "a.txt" },
      { index: 2, kind: "assistant", text: "done" },
    ]);
    expect((await getTranscript("tx", "?after=5")).entries).toEqual([]);
  });

  test("no transcript yet → empty", async () => {
    seedAgent("fresh");
    const body = await getTranscript("fresh");
    expect(body).toMatchObject({ provider: "claude", sessionId: null, total: 0, entries: [] });
  });

  test("unknown agent → 404, bad after → 400", async () => {
    expect((await fetch(url("/api/agents/ghost/transcript"), auth())).status).toBe(404);
    seedAgent("bad-after");
    expect((await fetch(url("/api/agents/bad-after/transcript?after=-1"), auth())).status).toBe(400);
    expect((await fetch(url("/api/agents/bad-after/transcript?after=x"), auth())).status).toBe(400);
  });

  test("interrupt: unknown agent → 404, no live session → 409", async () => {
    expect((await fetch(url("/api/agents/ghost/interrupt"), auth({ method: "POST" }))).status).toBe(404);
    seedAgent("noint");
    const bare = await fetch(url("/api/agents/noint/interrupt"), auth({ method: "POST" }));
    expect(bare.status).toBe(409);
    expect(((await bare.json()) as any).reason).toBe("no_session");
    const withText = await fetch(
      url("/api/agents/noint/interrupt"),
      auth({ method: "POST", body: JSON.stringify({ text: "stop" }), headers: { "content-type": "application/json" } }),
    );
    expect(withText.status).toBe(409);
    expect(((await withText.json()) as any).reason).toBe("no_session");
    const message = await fetch(
      url("/api/agents/noint/messages"),
      auth({ method: "POST", body: JSON.stringify({ text: "hi" }), headers: { "content-type": "application/json" } }),
    );
    expect(message.status).toBe(409);
    expect(((await message.json()) as any).reason).toBe("no_session");
  });

  test("non-string interrupt text, model or effort → 400", async () => {
    const post = (path: string, body: unknown) =>
      fetch(url(path), auth({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    seedAgent("badtext");
    expect((await post("/api/agents/badtext/interrupt", { text: 42 })).status).toBe(400);
    expect((await post("/api/agents", { name: "badmodel", model: 5 })).status).toBe(400);
    expect((await post("/api/agents", { name: "badeffort", effort: true })).status).toBe(400);
  });
});

describe("remote agents api (host:name)", () => {
  interface Call {
    host: string;
    args: string[];
    stdin?: string;
    timeoutMs?: number;
  }
  let calls: Call[];
  let reply: (call: Call) => { exitCode: number; stdout?: string; stderr?: string };

  beforeEach(() => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["laptop", "box.example.com"] }));
    calls = [];
    reply = () => ({ exitCode: 0, stdout: "" });
    setRemoteRunnersForTests({
      am: async (host, args, opts = {}) => {
        const call = { host, args, stdin: opts.stdin, timeoutMs: opts.timeoutMs };
        calls.push(call);
        const r = reply(call);
        return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      sh: async (host, command) => {
        calls.push({ host, args: ["sh", command] });
        return { exitCode: 0, stdout: "/Users/remote\n", stderr: "" };
      },
    });
    setFleetFetchForTests(async () => null);
    resetFleetCacheForTests();
  });

  afterEach(() => {
    setRemoteRunnersForTests();
    setFleetFetchForTests();
    resetFleetCacheForTests();
  });

  const post = (path: string, body?: unknown) =>
    fetch(url(path), auth({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  test("detail runs am __detail on the host and returns its JSON", async () => {
    const detail = { name: "api", status: "idle", queue: [], pane: "hi" };
    reply = () => ({ exitCode: 0, stdout: JSON.stringify(detail) });
    const res = await fetch(url("/api/agents/laptop:api"), auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(detail);
    expect(calls).toEqual([{ host: "laptop", args: ["__detail", "api", "--local", "--exact"], stdin: undefined, timeoutMs: 20_000 }]);
  });

  test("an encoded colon routes too; dotted hosts are accepted", async () => {
    reply = () => ({ exitCode: 0, stdout: "{}" });
    expect((await fetch(url("/api/agents/box.example.com%3Aapi"), auth())).status).toBe(200);
    expect(calls[0]!.host).toBe("box.example.com");
  });

  test("messages: queue/now via am send - --json (stdin), interrupt via am interrupt - --json", async () => {
    let n = 0;
    reply = (call) =>
      call.args[0] === "__detail"
        ? { exitCode: 0, stdout: JSON.stringify({ name: "api", messageReceipts: true }) }
        : { exitCode: 0, stdout: JSON.stringify({ id: `ID${++n}` }) };
    const first = await post("/api/agents/laptop:api/messages", { text: "hi `there`" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, mode: "queue", id: "ID1" });
    expect(await (await post("/api/agents/laptop:api/messages", { text: "steer", mode: "now" })).json()).toEqual({ ok: true, mode: "now", id: "ID2" });
    expect(await (await post("/api/agents/laptop:api/messages", { text: "stop that", mode: "interrupt" })).json()).toEqual({ ok: true, mode: "interrupt", id: "ID3" });
    expect(calls.map((c) => [c.args, c.stdin])).toEqual([
      [["__detail", "api", "--local", "--exact"], undefined],
      [["send", "api", "-", "--json", "--local", "--exact"], "hi `there`"],
      [["__detail", "api", "--local", "--exact"], undefined],
      [["send", "api", "-", "--json", "--now", "--local", "--exact"], "steer"],
      [["__detail", "api", "--local", "--exact"], undefined],
      [["interrupt", "api", "-", "--json", "--local", "--exact"], "stop that"],
    ]);
    calls.length = 0;
    expect((await post("/api/agents/laptop:api/messages", { mode: "queue" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("messages: an am without receipts is refused before anything is sent", async () => {
    reply = () => ({ exitCode: 0, stdout: JSON.stringify({ name: "api" }) });
    const res = await post("/api/agents/laptop:api/messages", { text: "hi" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "remote am too old on laptop (no message receipts)", reason: "remote_too_old" });
    expect(calls.map((c) => c.args[0])).toEqual(["__detail"]);
  });

  test("messages and interrupts: a remote refusal on stderr carries its reason", async () => {
    let stderr = "";
    reply = (call) =>
      call.args[0] === "__detail"
        ? { exitCode: 0, stdout: JSON.stringify({ name: "api", messageReceipts: true }) }
        : { exitCode: 1, stderr };
    const reasonOf = async (res: Response) => {
      expect(res.status).toBe(409);
      return ((await res.json()) as any).reason;
    };
    stderr = 'am: agent "api" has no live tmux session (status: exited)';
    expect(await reasonOf(await post("/api/agents/laptop:api/messages", { text: "hi" }))).toBe("no_session");
    expect(await reasonOf(await post("/api/agents/laptop:api/interrupt"))).toBe("no_session");
    stderr = 'am: agent "api" mailbox is busy — retry the message';
    expect(await reasonOf(await post("/api/agents/laptop:api/messages", { text: "hi", mode: "now" }))).toBe("mailbox_busy");
    expect(await reasonOf(await post("/api/agents/laptop:api/interrupt", { text: "redo" }))).toBe("mailbox_busy");
    stderr = "am: something unexpected";
    expect(await reasonOf(await post("/api/agents/laptop:api/messages", { text: "hi" }))).toBe("unknown");
    expect(await reasonOf(await post("/api/agents/laptop:api/interrupt"))).toBe("unknown");
    stderr = 'am: unknown command "interrupt"';
    expect(await reasonOf(await post("/api/agents/laptop:api/interrupt"))).toBe("remote_too_old");
  });

  test("message receipt and cancel forward to __message / __cancel", async () => {
    const record = { id: "01ABC", state: "delivered", queuedAt: "q", deliveredAt: "d", doneAt: null, transcriptIndex: 4 };
    reply = (call) => {
      if (call.args[0] === "__message") return { exitCode: 0, stdout: JSON.stringify(record) };
      if (call.args[2] === "01ABC") return { exitCode: 0, stdout: JSON.stringify({ ok: false, error: "message 01ABC is already delivered", state: "delivered", reason: "already_delivered" }) };
      if (call.args[2] === "01OLD") return { exitCode: 0, stdout: JSON.stringify({ ok: false, error: "message 01OLD is already done", state: "done" }) };
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, state: "cancelled" }) };
    };
    const got = await fetch(url("/api/agents/laptop:api/messages/01ABC"), auth());
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(record);
    const refused = await fetch(url("/api/agents/laptop:api/messages/01ABC"), auth({ method: "DELETE" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "message 01ABC is already delivered", state: "delivered", reason: "already_delivered" });
    const cancelled = await fetch(url("/api/agents/laptop:api/messages/01XYZ"), auth({ method: "DELETE" }));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true, state: "cancelled" });
    // A remote am from before reasons refuses without one: its state says why.
    const old = await fetch(url("/api/agents/laptop:api/messages/01OLD"), auth({ method: "DELETE" }));
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: "message 01OLD is already done", state: "done", reason: "already_done" });
    expect(calls.map((c) => c.args)).toEqual([
      ["__message", "api", "01ABC", "--local", "--exact"],
      ["__cancel", "api", "01ABC", "--local", "--exact"],
      ["__cancel", "api", "01XYZ", "--local", "--exact"],
      ["__cancel", "api", "01OLD", "--local", "--exact"],
    ]);
  });

  test("interrupt by messageId forwards to __interrupt", async () => {
    reply = (call) =>
      call.args[2] === "01ABC"
        ? { exitCode: 0, stdout: JSON.stringify({ ok: false, error: "message 01ABC is already done", state: "done", reason: "already_done" }) }
        : { exitCode: 0, stdout: JSON.stringify({ ok: true, state: "delivered" }) };
    const refused = await post("/api/agents/laptop:api/interrupt", { messageId: "01ABC" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "message 01ABC is already done", state: "done", reason: "already_done" });
    const ok = await post("/api/agents/laptop:api/interrupt", { messageId: "01XYZ" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls.map((c) => c.args)).toEqual([
      ["__interrupt", "api", "01ABC", "--local", "--exact"],
      ["__interrupt", "api", "01XYZ", "--local", "--exact"],
    ]);

    reply = () => ({ exitCode: 1, stderr: 'am: no message "01NOPE" for agent "api"' });
    expect((await post("/api/agents/laptop:api/interrupt", { messageId: "01NOPE" })).status).toBe(404);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__interrupt" — see `am help`' });
    const old = await post("/api/agents/laptop:api/interrupt", { messageId: "01NOPE" });
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: expect.stringContaining("remote am too old"), reason: "remote_too_old" });
    calls.length = 0;
    expect((await post("/api/agents/laptop:api/interrupt", { messageId: "a.b" })).status).toBe(404);
    expect((await post("/api/agents/laptop:api/interrupt", { messageId: "01ABC", text: "hi" })).status).toBe(400);
    expect((await post("/api/agents/laptop:api/interrupt", { messageId: 1 })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("message receipts: unknown id → 404, old am → 409, bad id never reaches ssh", async () => {
    reply = () => ({ exitCode: 1, stderr: 'am: no message "01NOPE" for agent "api"' });
    expect((await fetch(url("/api/agents/laptop:api/messages/01NOPE"), auth())).status).toBe(404);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__message" — see `am help`' });
    const old = await fetch(url("/api/agents/laptop:api/messages/01NOPE"), auth());
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: expect.stringContaining("remote am too old"), reason: "remote_too_old" });
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__cancel" — see `am help`' });
    const oldCancel = await fetch(url("/api/agents/laptop:api/messages/01NOPE"), auth({ method: "DELETE" }));
    expect(await oldCancel.json()).toMatchObject({ reason: "remote_too_old" });
    reply = () => ({ exitCode: 0, stdout: "not json" });
    const noJson = await fetch(url("/api/agents/laptop:api/messages/01NOPE"), auth({ method: "DELETE" }));
    expect(noJson.status).toBe(409);
    expect(await noJson.json()).toMatchObject({ reason: "remote_too_old" });
    calls.length = 0;
    expect((await fetch(url("/api/agents/laptop:api/messages/a.b"), auth())).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("transcript slices entries by after", async () => {
    const transcript = {
      provider: "claude", sessionId: "s", status: "idle", total: 3,
      entries: [0, 1, 2].map((index) => ({ index, kind: "user", text: String(index) })),
    };
    reply = () => ({ exitCode: 0, stdout: JSON.stringify(transcript) });
    const body = (await (await fetch(url("/api/agents/laptop:api/transcript?after=1"), auth())).json()) as any;
    expect(body.total).toBe(3);
    expect(body.entries.map((e: any) => e.index)).toEqual([1, 2]);
    expect(calls.map((c) => c.args[0])).toEqual(["__detail", "transcript"]);
    expect(calls[1]!.args).toEqual(["transcript", "api", "--json", "--local", "--exact"]);
    expect((await fetch(url("/api/agents/laptop:api/transcript?after=-1"), auth())).status).toBe(400);
  });

  test("transcript from an am without --json → 409 remote am too old", async () => {
    reply = () => ({ exitCode: 0, stdout: "# api\n\nmarkdown transcript" });
    const res = await fetch(url("/api/agents/laptop:api/transcript"), auth());
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("remote am too old");
  });

  test("interrupt with and without text; stop, resume, delete", async () => {
    await post("/api/agents/laptop:api/interrupt");
    await post("/api/agents/laptop:api/interrupt", { text: "new plan" });
    await post("/api/agents/laptop:api/stop");
    await post("/api/agents/laptop:api/resume");
    await fetch(url("/api/agents/laptop:api"), auth({ method: "DELETE" }));
    expect(calls.map((c) => [c.args, c.stdin])).toEqual([
      [["__detail", "api", "--local", "--exact"], undefined],
      [["interrupt", "api", "--local", "--exact"], undefined],
      [["__detail", "api", "--local", "--exact"], undefined],
      [["interrupt", "api", "-", "--local", "--exact"], "new plan"],
      [["__detail", "api", "--local", "--exact"], undefined],
      [["stop", "api", "--local", "--exact"], undefined],
      [["__detail", "api", "--local", "--exact"], undefined],
      [["resume", "api", "--local", "--exact"], undefined],
      [["__detail", "api", "--local", "--exact"], undefined],
      [["rm", "api", "--local", "--exact"], undefined],
    ]);
    expect((await post("/api/agents/laptop:api/interrupt", { text: 1 })).status).toBe(400);
  });

  test("an am without __detail (ignores --exact) is refused before any agent operation", async () => {
    reply = (call) =>
      call.args[0] === "__detail"
        ? { exitCode: 1, stderr: 'am: unknown command "__detail" — see `am help`' }
        : { exitCode: 0 };
    const res = await fetch(url("/api/agents/laptop:a"), auth({ method: "DELETE" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("remote am too old");
    expect(calls.map((c) => c.args[0])).toEqual(["__detail"]);
  });

  test("this host's own name and \"local\" stay local", async () => {
    seedAgent("mine");
    expect((await fetch(url(`/api/agents/${localHostIdentity()}:mine`), auth())).status).toBe(200);
    expect((await fetch(url("/api/agents/local:mine"), auth())).status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("error mapping: unknown host 404, ssh failure/timeout 502, cli failure 409, missing agent 404", async () => {
    expect((await fetch(url("/api/agents/nowhere:api"), auth())).status).toBe(404);
    reply = () => ({ exitCode: 255, stderr: "ssh: connect to host laptop port 22: No route to host" });
    const unreachable = await post("/api/agents/laptop:api/stop");
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as any).error).toContain("No route to host");
    reply = () => ({ exitCode: 124 });
    expect((await post("/api/agents/laptop:api/stop")).status).toBe(502);
    reply = () => ({ exitCode: 1, stderr: 'am: agent "api" has no live tmux session (status: exited)' });
    const failed = await post("/api/agents/laptop:api/messages", { text: "hi" });
    expect(failed.status).toBe(409);
    expect(((await failed.json()) as any).error).toBe('agent "api" has no live tmux session (status: exited)');
    reply = () => ({ exitCode: 1, stderr: 'am: no agent matches "api"' });
    expect((await post("/api/agents/laptop:api/stop")).status).toBe(404);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__detail" — see `am help`' });
    const old = await fetch(url("/api/agents/laptop:api"), auth());
    expect(old.status).toBe(409);
    expect(((await old.json()) as any).error).toContain("remote am too old");
  });

  test("names and hosts are validated before ssh or the filesystem", async () => {
    for (const bad of ["..%2F..%2Fconfig", "a%20b", "laptop:..%2Fx", "la%24(id):api", "laptop:", "%E0%A4%A"]) {
      expect((await fetch(url(`/api/agents/${bad}`), auth())).status).toBe(400);
      expect((await fetch(url(`/api/agents/${bad}/transcript`), auth())).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("POST /api/agents with host maps a $HOME dir onto the remote $HOME", async () => {
    const res = await post("/api/agents", {
      name: "far", host: "laptop", task: "fix it", dir: join(homedir(), "code", "app"),
      provider: "claude", model: "opus", effort: "high", role: "engineer", inPlace: true,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, name: "far", host: "laptop" });
    expect(calls[0]).toEqual({ host: "laptop", args: ["sh", "echo $HOME"] });
    expect(calls[1]).toEqual({
      host: "laptop",
      args: ["new", "far", "--no-jump", "-m", "-", "--dir", "/Users/remote/code/app", "--in-place", "--claude",
        "--model", "opus", "--effort", "high", "--role", "engineer", "--local", "--exact"],
      stdin: "fix it",
      timeoutMs: 90_000,
    });
  });

  test("POST with remoteDir skips the mapping; non-home dir needs remoteDir", async () => {
    await post("/api/agents", { name: "far", host: "laptop", dir: "/srv/x", remoteDir: "/opt/y", codex: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["new", "far", "--no-jump", "--dir", "/opt/y", "--codex", "--local", "--exact"]);
    expect((await post("/api/agents", { name: "far", host: "laptop", dir: "/srv/x" })).status).toBe(400);
    expect((await post("/api/agents", { name: "far", host: "laptop", remoteDir: "rel" })).status).toBe(400);
  });

  test("POST with host: unknown 404, invalid 400, bad name 409, cli failure 409", async () => {
    expect((await post("/api/agents", { name: "far", host: "nowhere" })).status).toBe(404);
    expect((await post("/api/agents", { name: "far", host: "a;b" })).status).toBe(400);
    expect((await post("/api/agents", { name: "bad name", host: "laptop" })).status).toBe(409);
    reply = () => ({ exitCode: 1, stderr: 'am: agent "far" already exists' });
    const res = await post("/api/agents", { name: "far", host: "laptop" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe('agent "far" already exists');
  });

  test("GET /api/hosts lists this host and the configured remotes", async () => {
    const res = await fetch(url("/api/hosts"), auth());
    const body = (await res.json()) as any;
    expect(body.local).toBe(localHostIdentity());
    expect(body.hosts.map((h: any) => h.name)).toEqual(["laptop", "box.example.com"]);
    expect(body.hosts.every((h: any) => typeof h.reachable === "boolean")).toBe(true);
  });
});

describe("token storage", () => {
  test("createApiToken persists and loadApiToken reads it", () => {
    const tok = createApiToken();
    expect(tok).toHaveLength(32); // 24 bytes base64url
    expect(loadApiToken()).toBe(tok);
  });

  test("AM_API_TOKEN env overrides the file", () => {
    createApiToken();
    process.env.AM_API_TOKEN = "env-wins";
    expect(loadApiToken()).toBe("env-wins");
  });
});
