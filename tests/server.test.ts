import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, loadApiToken, createApiToken, type ApiServerHandle } from "../src/server";
import { readAgent, writeAgent } from "../src/state";
import { queueAppend } from "../src/queue";
import { daemonRequest, startDaemonServer } from "../src/daemon";

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

  test("GET /api/agents/:name returns detail + queue", async () => {
    seedAgent("beta");
    queueAppend("beta", "hello");
    const res = await fetch(url("/api/agents/beta"), auth());
    const data = (await res.json()) as any;
    expect(data.name).toBe("beta");
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].message).toBe("hello");
    expect(data.pane).toBeNull(); // no live session
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

describe("transcript api", () => {
  // locateTranscript prefers agent.transcriptPath when the file exists, so a
  // temp JSONL stands in for a real ~/.claude/projects session file.
  function seedWithTranscript(name: string, jsonlLines: object[]) {
    const file = join(home, `${name}-session.jsonl`);
    writeFileSync(file, jsonlLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const now = new Date().toISOString();
    writeAgent({
      name,
      status: "idle",
      dir: "/tmp",
      tmuxSession: `agentmgr-${name}`,
      transcriptPath: file,
      createdAt: now,
      updatedAt: now,
    });
  }

  const SESSION = [
    { type: "user", sessionId: "s-1", cwd: "/tmp", message: { role: "user", content: "fix the tests" } },
    {
      type: "assistant",
      sessionId: "s-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Looking now." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: "s-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "x".repeat(2000) }] }],
      },
    },
    { type: "assistant", sessionId: "s-1", message: { role: "assistant", content: [{ type: "text", text: "All green." }] } },
  ];

  test("returns status, provider, total, and parsed turns", async () => {
    seedWithTranscript("talker", SESSION);
    const res = await fetch(url("/api/agents/talker/transcript"), auth());
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.status).toBe("dead"); // no real tmux session in tests
    expect(data.provider).toBe("claude");
    expect(data.total).toBe(4); // user, assistant text, tool, assistant text
    expect(data.turns.map((t: any) => t.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(data.turns[3].text).toBe("All green.");
  });

  test("after cursor returns only new turns; total stays absolute", async () => {
    seedWithTranscript("cursor", SESSION);
    const res = await fetch(url("/api/agents/cursor/transcript?after=3"), auth());
    const data = (await res.json()) as any;
    expect(data.total).toBe(4);
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0].text).toBe("All green.");
  });

  test("after at or past total yields empty turns", async () => {
    seedWithTranscript("caught-up", SESSION);
    const res = await fetch(url("/api/agents/caught-up/transcript?after=4"), auth());
    const data = (await res.json()) as any;
    expect(data.turns).toEqual([]);
    expect(data.total).toBe(4);
  });

  test("tool output is truncated to compact limits", async () => {
    seedWithTranscript("chatty-tool", SESSION);
    const res = await fetch(url("/api/agents/chatty-tool/transcript"), auth());
    const data = (await res.json()) as any;
    const tool = data.turns.find((t: any) => t.kind === "tool");
    expect(tool.name).toBe("Bash");
    expect(tool.output.length).toBeLessThan(600);
    expect(tool.output).toContain("chars]"); // truncation marker
  });

  test("agent with no session yet → empty transcript, not an error", async () => {
    seedAgent("newborn");
    const res = await fetch(url("/api/agents/newborn/transcript"), auth());
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.total).toBe(0);
    expect(data.turns).toEqual([]);
  });

  test("unknown agent → 404", async () => {
    expect((await fetch(url("/api/agents/ghost/transcript"), auth())).status).toBe(404);
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
