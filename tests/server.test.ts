import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, loadApiToken, createApiToken, type ApiServerHandle } from "../src/server";
import { readAgent, writeAgent } from "../src/state";
import { queueAppend } from "../src/queue";
import { daemonRequest, startDaemonServer } from "../src/daemon";
import { addRole } from "../src/roles";

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
    expect((await fetch(url("/api/agents/noint/interrupt"), auth({ method: "POST" }))).status).toBe(409);
    const withText = await fetch(
      url("/api/agents/noint/interrupt"),
      auth({ method: "POST", body: JSON.stringify({ text: "stop" }), headers: { "content-type": "application/json" } }),
    );
    expect(withText.status).toBe(409);
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
