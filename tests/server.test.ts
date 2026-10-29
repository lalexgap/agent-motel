import * as migration from "../src/commands/move";
import * as handover from "../src/commands/handoff";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, loadApiToken, createApiToken, resetModelsCacheForTests, type ApiServerHandle } from "../src/server";
import { recordSubagentStart, recordSubagentStop } from "../src/subagents";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { queueAppend, queueDepth, queuePopId } from "../src/queue";
import { acquireDeliverLock, deliverNext, releaseDeliverLock, type DeliveryResult } from "../src/deliver";
import { markDelivered, queueTrackedMessage, readMessage } from "../src/messages";
import { daemonRequest, startDaemonServer } from "../src/daemon";
import { acquireLifecycleLock, releaseLifecycleLock } from "../src/lifecycle";
import { addRole } from "../src/roles";
import { setRemoteRunnersForTests } from "../src/remoteAgents";
import { localHostIdentity } from "../src/config";
import { resetFleetCacheForTests, setFleetFetchForTests } from "../src/fleet";
import { claimAnswer, claudePermissionOptions, createPermission, listPermissions, readPermission } from "../src/permissions";

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

function seedAgent(name: string, status: AgentState["status"] = "idle") {
  const now = new Date().toISOString();
  writeAgent({ name, status, dir: "/tmp", tmuxSession: `agentmgr-${name}`, createdAt: now, updatedAt: now });
}

describe("agent move API", () => {
  test("validates configured destination, exact source, direction and directory before moving", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["laptop"] }));
    seedAgent("source");
    const move = spyOn(migration, "moveAgent").mockResolvedValue("moved");
    const post = (key: string, body: unknown) => fetch(url(`/api/agents/${key}/move`), auth({ method: "POST", body: JSON.stringify(body) }));
    try {
      expect((await fetch(url("/api/agents/source/move"), { method: "POST", body: "{}" })).status).toBe(401);
      expect((await post("source", {})).status).toBe(400);
      expect((await post("source", { host: "unknown" })).status).toBe(404);
      expect((await post("source", { host: "local" })).status).toBe(400);
      expect((await post("source", { host: "laptop", dir: "relative" })).status).toBe(400);
      expect((await post("sour", { host: "laptop" })).status).toBe(404);
      expect((await post("laptop:source", { host: "laptop" })).status).toBe(400);
      expect(move).not.toHaveBeenCalled();
      const response = await post("source", { host: "laptop", dir: "/tmp/destination" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ key: "laptop:source" });
      expect(move).toHaveBeenCalledWith("source", "laptop", { copy: false, start: true, exact: true, dir: "/tmp/destination" });
      move.mockRejectedValueOnce(new Error("destination unavailable"));
      expect((await post("source", { host: "laptop" })).status).toBe(409);
    } finally { move.mockRestore(); }
  });
});

describe("agent workspace", () => {
  test("requires authentication and reports missing agents and non-repository directories", async () => {
    expect((await fetch(url("/api/agents/missing/workspace"))).status).toBe(401);
    expect((await fetch(url("/api/agents/missing/workspace"), auth())).status).toBe(404);
    seedAgent("workspace");
    const response = await fetch(url("/api/agents/workspace/workspace"), auth());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false, files: [], pullRequests: [] });
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("pasted image upload", () => {
  const upload = (key: string, body: string | Uint8Array, type = "image/png", authenticated = true) => {
    const init: RequestInit = { method: "POST", body, headers: { "content-type": type } };
    return fetch(url(`/api/agents/${key}/files`), authenticated ? auth(init) : init);
  };

  test("requires authentication and an existing local agent", async () => {
    expect((await upload("pasty", PNG, "image/png", false)).status).toBe(401);
    expect((await upload("pasty", PNG)).status).toBe(404);
    expect((await upload("..%2Fetc", PNG)).status).toBe(400);
  });

  test("rejects non-image types, mismatched bytes, empty bodies and oversized images", async () => {
    seedAgent("pasty");
    expect((await upload("pasty", "hello", "text/plain")).status).toBe(415);
    expect((await upload("pasty", PNG, "image/svg+xml")).status).toBe(415);
    expect((await upload("pasty", "<svg/>", "image/png")).status).toBe(415);
    expect((await upload("pasty", new Uint8Array(0))).status).toBe(400);
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(PNG);
    expect((await upload("pasty", huge)).status).toBe(413);
    expect(existsSync(join(home, "inbox", "pasty"))).toBe(false);
  });

  test("writes the image into the agent's inbox under a server-chosen name", async () => {
    seedAgent("pasty");
    const response = await upload("pasty", PNG, "image/png; charset=binary");
    expect(response.status).toBe(201);
    const { path } = (await response.json()) as { path: string };
    expect(path.startsWith(join(home, "inbox", "pasty") + "/")).toBe(true);
    expect(path).toMatch(/\/paste-\d+-[0-9a-f]{8}\.png$/);
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const jpeg = await upload("pasty", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]), "image/jpeg");
    expect(((await jpeg.json()) as { path: string }).path).toMatch(/\.jpg$/);
  });

  test("other routes keep the small JSON body cap", async () => {
    seedAgent("pasty");
    const big = JSON.stringify({ text: "x".repeat(300 * 1024) });
    const response = await fetch(url("/api/agents/pasty/messages"), auth({ method: "POST", body: big }));
    expect(response.status).toBe(413);
    const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{}")); c.close(); } });
    expect((await fetch(url("/api/agents/pasty/messages"), auth({ method: "POST", body: chunked }))).status).toBe(413);
    expect((await fetch(url("/api/agents/pasty/resume"), auth({ method: "POST" }))).status).not.toBe(413);
  });
});

describe("agent handover API", () => {
  test("requires authentication and validates the provider, name and transcript option before spawning", async () => {
    const post = (body: unknown, authenticated = true) => fetch(url("/api/agents/source/handoff"), authenticated ? auth({ method: "POST", body: JSON.stringify(body) }) : { method: "POST", body: JSON.stringify(body) });
    expect((await post({ to: "codex" }, false)).status).toBe(401);
    for (const body of [{}, { to: "other" }, { to: "codex", newName: "../bad" }, { to: "codex", newName: "a".repeat(65) }, { to: "codex", full: "yes" }])
      expect((await post(body)).status).toBe(400);
    expect((await post({ to: "codex" })).status).toBe(404);
  });

  test("hands over an exact local agent and returns the new selectable key", async () => {
    seedAgent("source");
    const handoff = spyOn(handover, "handoffAgent").mockResolvedValue({ name: "source-codex", target: "codex", file: "/private/transcript.md" });
    try {
      const response = await fetch(url("/api/agents/source/handoff"), auth({ method: "POST", body: JSON.stringify({ to: "codex", full: true }) }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true, name: "source-codex", target: "codex", key: "source-codex" });
      expect(handoff).toHaveBeenCalledWith("source", { to: "codex", newName: undefined, full: true, exact: true, jump: false, quiet: true });
      expect(readAgent("source")?.status).toBe("idle");
    } finally { handoff.mockRestore(); }
  });
});

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

describe("permissions api", () => {
  const seedPermission = (over: Record<string, unknown> = {}) => {
    const { options, decisions } = claudePermissionOptions([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" },
    ]);
    return createPermission({
      agent: "api", provider: "claude", tool: "Bash", summary: "Bash: ls", input: { command: "ls" },
      options, decisions, expiresAt: new Date(Date.now() + 60_000).toISOString(), pid: process.pid,
      claude: { toolInput: { command: "ls" }, transcriptPath: "/nowhere" }, ...over,
    });
  };
  const post = (path: string, body?: unknown) =>
    fetch(url(path), auth({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  test("GET lists pending requests in the public shape; detail flags the capability and count", async () => {
    seedAgent("api");
    const record = seedPermission();
    seedPermission({ agent: "web" });
    const res = await fetch(url("/api/agents/api/permissions"), auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requests: [{
        id: record.id, provider: "claude", tool: "Bash", summary: "Bash: ls", input: { command: "ls" },
        options: [
          { id: "allow", label: "Yes", kind: "allow" },
          { id: "suggestion-0", label: "Yes, and always allow Bash(ls) (saved to .claude/settings.local.json)", kind: "allow_always" },
          { id: "deny", label: "No", kind: "deny" },
        ],
        createdAt: record.createdAt, expiresAt: record.expiresAt,
      }],
    });
    const detail = (await (await fetch(url("/api/agents/api"), auth())).json()) as any;
    expect(detail.permissionRequests).toBe(true);
    expect(detail.pendingPermissions).toBe(1);
    expect((await fetch(url("/api/agents/ghost/permissions"), auth())).status).toBe(404);
  });

  test("POST applies a decision once; then 409 already_resolved", async () => {
    seedAgent("api");
    const record = seedPermission();
    const taker = setInterval(() => claimAnswer(record.id), 20);
    try {
      const res = await post(`/api/agents/api/permissions/${record.id}`, { optionId: "suggestion-0" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: record.id, optionId: "suggestion-0" });
    } finally {
      clearInterval(taker);
    }
    expect(readPermission(record.id)!.state).toBe("applied");
    const again = await post(`/api/agents/api/permissions/${record.id}`, { optionId: "allow" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).reason).toBe("already_resolved");
    const list = (await (await fetch(url("/api/agents/api/permissions"), auth())).json()) as any;
    expect(list.requests).toEqual([]);
  });

  test("POST errors: expired 409, not_pending 409, unknown id 404, bad option 400", async () => {
    seedAgent("api");
    const expired = seedPermission({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const res = await post(`/api/agents/api/permissions/${expired.id}`, { optionId: "allow" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "expired" });
    const orphan = seedPermission({ pid: 999_999_999 });
    expect(await (await post(`/api/agents/api/permissions/${orphan.id}`, { optionId: "allow" })).json()).toMatchObject({ reason: "not_pending" });
    expect((await post("/api/agents/api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: "allow" })).status).toBe(404);
    expect((await post("/api/agents/api/permissions/..%2Fx", { optionId: "allow" })).status).toBe(404);
    const live = seedPermission();
    expect((await post(`/api/agents/api/permissions/${live.id}`, { optionId: "always-yes" })).status).toBe(400);
    expect((await post(`/api/agents/api/permissions/${live.id}`, { optionId: "../x" })).status).toBe(400);
    expect((await post(`/api/agents/api/permissions/${live.id}`, {})).status).toBe(400);
    // Another agent's request isn't reachable through this one.
    seedAgent("web");
    expect((await post(`/api/agents/web/permissions/${live.id}`, { optionId: "allow" })).status).toBe(404);
    expect(readPermission(live.id)!.state).toBe("pending");
    expect(listPermissions().filter((r) => r.state === "answered")).toEqual([]);
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

describe("stop ifIdle", () => {
  // Fake tmux: sessions in `live` exist, panes are empty, and kill-session
  // runs `onKill` — while the stop still holds the mailbox locks.
  let live: Set<string>;
  let onKill: () => void;
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    live = new Set();
    onKill = () => {};
    const spawn = Bun.spawnSync.bind(Bun);
    spawnSpy = spyOn(Bun, "spawnSync").mockImplementation(((cmd: any, opts?: any) => {
      if (!Array.isArray(cmd) || cmd[0] !== "tmux") return spawn(cmd, opts);
      const session = String(cmd[3] ?? "").replace(/^=/, "").replace(/:.*$/, "");
      let exitCode = 0;
      if (cmd[1] === "has-session") exitCode = live.has(session) ? 0 : 1;
      if (cmd[1] === "kill-session") {
        onKill();
        live.delete(session);
      }
      return { exitCode, stdout: Buffer.from(""), stderr: Buffer.from(""), success: exitCode === 0 } as any;
    }) as any);
  });

  afterEach(() => spawnSpy?.mockRestore());

  const stop = (name: string, body?: unknown) =>
    fetch(url(`/api/agents/${name}/stop`), auth({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  function liveAgent(name: string, status: AgentState["status"] = "idle") {
    seedAgent(name, status);
    live.add(`agentmgr-${name}`);
  }

  test("an idle agent with nothing pending is stopped", async () => {
    liveAgent("calm");
    const res = await stop("calm", { ifIdle: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(readAgent("calm")!.status).toBe("exited");
    expect(live.has("agentmgr-calm")).toBe(false);
  });

  test("a busy agent is refused with reason busy and left running", async () => {
    for (const status of ["working", "starting", "needs-attention"] as const) {
      liveAgent(`b-${status}`, status);
      const res = await stop(`b-${status}`, { ifIdle: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `agent "b-${status}" is ${status}`, reason: "busy" });
      expect(readAgent(`b-${status}`)!.status).toBe(status);
      expect(live.has(`agentmgr-b-${status}`)).toBe(true);
    }
  });

  test("queued messages refuse with reason queued", async () => {
    liveAgent("q");
    queueAppend("q", "later");
    const res = await stop("q", { ifIdle: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason).toBe("queued");
    expect(readAgent("q")!.status).toBe("idle");
  });

  test("a delivered message whose turn has not finished refuses with reason in_turn", async () => {
    liveAgent("t");
    const id = queueTrackedMessage("t", "do it");
    queuePopId("t", `${id}.json`);
    markDelivered("t", `${id}.json`);
    expect(readMessage("t", id)!.state).toBe("delivered");
    const res = await stop("t", { ifIdle: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason).toBe("in_turn");
    expect(readAgent("t")!.status).toBe("idle");
  });

  test("no delivery or enqueue can start while the stop holds the lock", async () => {
    liveAgent("race");
    let delivery: Promise<DeliveryResult> | undefined;
    let enqueueError: Error | undefined;
    onKill = () => {
      // deliverNext takes the delivery lock before its first await.
      delivery = deliverNext("race");
      try {
        queueAppend("race", "slipped in");
      } catch (error) {
        enqueueError = error as Error;
      }
    };
    const res = await stop("race", { ifIdle: true });
    expect(res.status).toBe(200);
    expect(await delivery).toEqual({ status: "queued", reason: "locked" });
    expect(enqueueError?.message).toContain("mailbox is busy");
    expect(queueDepth("race")).toBe(0);
    expect(readAgent("race")!.status).toBe("exited");
    // Both locks are free again afterwards.
    expect(acquireDeliverLock("race")).toBe(true);
    releaseDeliverLock("race");
    queueAppend("race", "after");
    expect(queueDepth("race")).toBe(1);
  });

  test("a dead or exited agent counts as idle, even with messages queued", async () => {
    seedAgent("gone");
    queueAppend("gone", "for resume");
    const dead = await stop("gone", { ifIdle: true });
    expect(dead.status).toBe(200);
    expect(readAgent("gone")!.status).toBe("exited");
    expect(queueDepth("gone")).toBe(1);
    const again = await stop("gone", { ifIdle: true });
    expect(again.status).toBe(200);
  });

  test("a stop that cannot take the lifecycle lock is refused as busy", async () => {
    liveAgent("held");
    expect(acquireLifecycleLock("held")).toBe(true);
    try {
      const res = await stop("held", { ifIdle: true });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).reason).toBe("busy");
      expect(readAgent("held")!.status).toBe("idle");
    } finally {
      releaseLifecycleLock("held");
    }
  });

  test("waits out a delivery in progress, then checks", async () => {
    liveAgent("wait");
    expect(acquireDeliverLock("wait")).toBe(true);
    setTimeout(() => releaseDeliverLock("wait"), 300);
    const res = await stop("wait", { ifIdle: true });
    expect(res.status).toBe(200);
    expect(readAgent("wait")!.status).toBe("exited");
  });

  test("without the flag a busy agent is stopped as before; bad bodies are rejected", async () => {
    liveAgent("plain", "working");
    expect((await stop("plain")).status).toBe(200);
    expect(readAgent("plain")!.status).toBe("exited");
    liveAgent("plain2", "working");
    expect((await stop("plain2", { ifIdle: false })).status).toBe(200);
    expect((await stop("plain2", { ifIdle: "yes" })).status).toBe(400);
    expect((await stop("missing", { ifIdle: true })).status).toBe(404);
  });

  test("a handover within the grace before the idle transition still refuses; one before it does not", async () => {
    const idleAt = Date.now() - 60_000;
    const at = (ms: number) => new Date(idleAt + ms).toISOString();
    liveAgent("grace");
    writeAgent({ ...readAgent("grace")!, promptAt: at(-10_000), lastHandoffAt: at(-1_500), statusChangedAt: at(0) });
    const res = await stop("grace", { ifIdle: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'agent "grace" was handed a message it has not started on yet', reason: "in_turn" });
    expect(live.has("agentmgr-grace")).toBe(true);
    writeAgent({ ...readAgent("grace")!, lastHandoffAt: at(-2_500) });
    expect((await stop("grace", { ifIdle: true })).status).toBe(200);
  });

  test("a turn shorter than the grace, prompted after the handover, does not block the stop", async () => {
    const handoffAt = Date.now() - 60_000;
    const at = (ms: number) => new Date(handoffAt + ms).toISOString();
    liveAgent("short");
    writeAgent({ ...readAgent("short")!, lastHandoffAt: at(0), promptAt: at(100), statusChangedAt: at(500) });
    expect((await stop("short", { ifIdle: true })).status).toBe(200);
    expect(readAgent("short")!.status).toBe("exited");
  });

  test("detail and health advertise stopIfIdle", async () => {
    liveAgent("cap");
    expect(((await (await fetch(url("/api/agents/cap"), auth())).json()) as any).stopIfIdle).toBe(true);
    expect(((await (await fetch(url("/api/health"), auth())).json()) as any).stopIfIdle).toBe(true);
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
  let pushed: { host: string; remotePath: string; bytes: Uint8Array }[];
  let reply: (call: Call) => { exitCode: number; stdout?: string; stderr?: string };

  beforeEach(() => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["laptop", "box.example.com"] }));
    calls = [];
    pushed = [];
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
      push: async (host, srcPath, remotePath) => {
        pushed.push({ host, remotePath, bytes: new Uint8Array(readFileSync(srcPath)) });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    setFleetFetchForTests(async () => null);
    resetFleetCacheForTests();
    resetModelsCacheForTests();
  });

  afterEach(() => {
    setRemoteRunnersForTests();
    setFleetFetchForTests();
    resetFleetCacheForTests();
  });

  const post = (path: string, body?: unknown) =>
    fetch(url(path), auth({ method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

  test("pasted images are pushed into the remote agent's inbox", async () => {
    const send = (key: string, body: string | Uint8Array, type = "image/png") =>
      fetch(url(`/api/agents/${key}/files`), auth({ method: "POST", body, headers: { "content-type": type } }));
    expect((await send("laptop:worker", "text", "text/plain")).status).toBe(415);
    expect(calls).toHaveLength(0);
    const response = await send("laptop:worker", PNG);
    expect(response.status).toBe(201);
    const { path } = (await response.json()) as { path: string };
    expect(path).toMatch(/^\/Users\/remote\/\.agent-manager\/inbox\/worker\/paste-\d+-[0-9a-f]{8}\.png$/);
    expect(calls[0]?.args).toEqual(["__detail", "worker", "--local", "--exact"]);
    expect(calls.some((call) => call.args[1] === `mkdir -p '/Users/remote/.agent-manager/inbox/worker' && (umask 077 && : > '${path}')`)).toBe(true);
    expect(pushed).toEqual([{ host: "laptop", remotePath: path, bytes: PNG }]);
    reply = () => ({ exitCode: 1, stderr: 'am: no local agent "ghost"' });
    expect((await send("laptop:ghost", PNG)).status).toBe(404);
    expect(pushed).toHaveLength(1);
  });

  test("remote diff sends literal filenames on stdin and handles old hosts", async () => {
    reply = () => ({ exitCode: 0, stdout: JSON.stringify({ path: "--strange file", diff: "+new", binary: false, truncated: false }) });
    const response = await fetch(url("/api/agents/laptop:workspace/diff?path=--strange%20file"), auth());
    expect(response.status).toBe(200);
    expect(calls[0]?.args).toEqual(["__workspace-diff", "workspace", "--local", "--exact"]);
    expect(calls[0]?.stdin).toBe(JSON.stringify("--strange file"));
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__workspace-diff"' });
    expect((await fetch(url("/api/agents/laptop:workspace/diff?path=file"), auth())).status).toBe(409);
  });

  test("workspace forwards exact remote names and older hosts fail explicitly", async () => {
    const workspace = { available: true, branch: "feature", files: [], total: 0, pullRequests: [] };
    reply = () => ({ exitCode: 0, stdout: JSON.stringify(workspace) });
    const response = await fetch(url("/api/agents/laptop:workspace/workspace"), auth());
    expect(await response.json()).toEqual(workspace);
    expect(calls[0]?.args).toEqual(["__workspace", "workspace", "--local", "--exact"]);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__workspace"' });
    const old = await fetch(url("/api/agents/laptop:old-workspace/workspace"), auth());
    expect(old.status).toBe(409);
    expect((await old.json() as { error: string }).error).toContain("remote am too old");
  });

  test("handover runs the exact internal helper on the source host", async () => {
    reply = () => ({ exitCode: 0, stdout: JSON.stringify({ name: "replacement", target: "codex", file: "/private/transcript.md" }) });
    const response = await post("/api/agents/laptop:source/handoff", { to: "codex", newName: "replacement", full: true });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, name: "replacement", target: "codex", key: "laptop:replacement" });
    expect(calls[0]).toEqual({ host: "laptop", args: ["__handoff", "source", "--to", "codex", "--new-name", "replacement", "--full", "--local", "--exact"], stdin: undefined, timeoutMs: 90000 });
  });

  test("handover refuses invalid input, old remotes and unsafe remote results", async () => {
    expect((await post("/api/agents/laptop:source/handoff", { to: "invalid" })).status).toBe(400);
    expect(calls).toHaveLength(0);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__handoff"' });
    expect((await post("/api/agents/laptop:source/handoff", { to: "codex" })).status).toBe(409);
    reply = () => ({ exitCode: 0, stdout: JSON.stringify({ name: "other:agent", target: "codex" }) });
    expect((await post("/api/agents/laptop:source/handoff", { to: "codex" })).status).toBe(502);
  });

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

  test("remote rename validates names and uses exact remote transport", async () => {
    expect((await post("/api/agents/laptop:api/rename", { name: "../bad" })).status).toBe(400);
    expect(calls).toHaveLength(0);
    const response = await post("/api/agents/laptop:api/rename", { name: "new-name" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: "laptop:new-name" });
    expect(calls.map(c => c.args)).toEqual([["__detail", "api", "--local", "--exact"], ["rename", "api", "new-name", "--local", "--exact"]]);
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

  test("stop ifIdle: capability-checked, forwarded as stop --if-idle, refusals keep their reason", async () => {
    let outcome: unknown = { ok: true };
    let capable = true;
    reply = (call) =>
      call.args[0] === "__detail"
        ? { exitCode: 0, stdout: JSON.stringify({ name: "api", ...(capable ? { stopIfIdle: true } : {}) }) }
        : { exitCode: 0, stdout: JSON.stringify(outcome) };
    const ok = await post("/api/agents/laptop:api/stop", { ifIdle: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls.map((c) => c.args)).toEqual([
      ["__detail", "api", "--local", "--exact"],
      ["stop", "api", "--if-idle", "--local", "--exact"],
    ]);
    for (const reason of ["busy", "queued", "in_turn"]) {
      outcome = { ok: false, error: `nope (${reason})`, reason };
      const res = await post("/api/agents/laptop:api/stop", { ifIdle: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `nope (${reason})`, reason });
    }
    // An older am would ignore --if-idle and stop regardless: never sent.
    capable = false;
    calls.length = 0;
    const old = await post("/api/agents/laptop:api/stop", { ifIdle: true });
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: "remote am too old on laptop (no stop --if-idle)", reason: "remote_too_old" });
    expect(calls.map((c) => c.args[0])).toEqual(["__detail"]);
    expect((await post("/api/agents/laptop:api/stop", { ifIdle: 1 })).status).toBe(400);
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

  test("permissions forward to __permissions / __permission", async () => {
    const list = { requests: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", provider: "codex", tool: "Bash" }] };
    reply = (call) => {
      if (call.args[0] === "__permissions") return { exitCode: 0, stdout: JSON.stringify(list) };
      if (call.args[3] === "accept") return { exitCode: 0, stdout: JSON.stringify({ ok: true, id: call.args[2], optionId: "accept" }) };
      return { exitCode: 0, stdout: JSON.stringify({ ok: false, error: "permission request expired", reason: "expired" }) };
    };
    const got = await fetch(url("/api/agents/laptop:api/permissions"), auth());
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(list);
    const ok = await post("/api/agents/laptop:api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: "accept" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", optionId: "accept" });
    const late = await post("/api/agents/laptop:api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: "decline" });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "permission request expired", reason: "expired" });
    expect(calls.map((c) => [c.args, c.timeoutMs])).toEqual([
      [["__permissions", "api", "--local", "--exact"], 20_000],
      [["__permission", "api", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "accept", "--local", "--exact"], 30_000],
      [["__permission", "api", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "decline", "--local", "--exact"], 30_000],
    ]);
  });

  test("permissions: unknown id 404, bad option 400, old am 409, bad input never reaches ssh", async () => {
    reply = () => ({ exitCode: 1, stderr: 'am: no permission request "01ARZ3NDEKTSV4RRFFQ69G5FAV" for agent "api"' });
    expect((await post("/api/agents/laptop:api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: "accept" })).status).toBe(404);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown permission option "nope" for request 01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect((await post("/api/agents/laptop:api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: "nope" })).status).toBe(400);
    reply = () => ({ exitCode: 1, stderr: 'am: unknown command "__permissions" — see `am help`' });
    const old = await fetch(url("/api/agents/laptop:api/permissions"), auth());
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ reason: "remote_too_old" });
    calls.length = 0;
    expect((await post("/api/agents/laptop:api/permissions/a.b", { optionId: "accept" })).status).toBe(404);
    expect((await post("/api/agents/laptop:api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: "a b" })).status).toBe(400);
    expect((await post("/api/agents/laptop:api/permissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", { optionId: 3 })).status).toBe(400);
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

  test("models: forwarded as am models --json, cached per host, refresh=1 bypasses", async () => {
    const catalogs = [
      { provider: "codex", models: [{ id: "gpt-6-luna", label: "Luna", efforts: ["low", "high"], defaultEffort: "low" }], efforts: ["low", "high"], modelsExhaustive: true, effortsExhaustive: true },
    ];
    reply = () => ({ exitCode: 0, stdout: JSON.stringify(catalogs) });
    const first = await fetch(url("/api/models?host=laptop"), auth());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(catalogs);
    expect(await (await fetch(url("/api/models?host=laptop"), auth())).json()).toEqual(catalogs);
    expect(calls).toEqual([{ host: "laptop", args: ["models", "--json", "--local", "--exact"], stdin: undefined, timeoutMs: 15_000 }]);
    // Another host has its own entry.
    await fetch(url("/api/models?host=box.example.com"), auth());
    expect(calls.map((c) => c.host)).toEqual(["laptop", "box.example.com"]);
    await fetch(url("/api/models?host=laptop&refresh=1"), auth());
    expect(calls.map((c) => c.host)).toEqual(["laptop", "box.example.com", "laptop"]);
  });

  test("models: unknown host 404, invalid 400, ssh failure 502 (not cached)", async () => {
    expect((await fetch(url("/api/models?host=nowhere"), auth())).status).toBe(404);
    expect((await fetch(url("/api/models?host=a%3Bb"), auth())).status).toBe(400);
    reply = () => ({ exitCode: 255, stderr: "ssh: connect to host laptop port 22: No route to host" });
    expect((await fetch(url("/api/models?host=laptop"), auth())).status).toBe(502);
    reply = () => ({ exitCode: 0, stdout: "[]" });
    expect((await fetch(url("/api/models?host=laptop"), auth())).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("restart: capability-checked, forwarded with --model/--effort/--if-idle --json", async () => {
    let outcome: unknown = { ok: true, model: "gpt-6.1-sol", effort: "high" };
    let capable = true;
    reply = (call) =>
      call.args[0] === "__detail"
        ? { exitCode: 0, stdout: JSON.stringify({ name: "api", ...(capable ? { restartModel: true } : {}) }) }
        : { exitCode: 0, stdout: JSON.stringify(outcome) };
    const ok = await post("/api/agents/laptop:api/restart", { model: "gpt-6.1-sol", effort: "high" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, model: "gpt-6.1-sol", effort: "high" });
    expect(calls.map((c) => [c.args, c.timeoutMs])).toEqual([
      [["__detail", "api", "--local", "--exact"], 20_000],
      [["restart", "api", "--json", "--model", "gpt-6.1-sol", "--effort", "high", "--local", "--exact"], 60_000],
    ]);
    calls.length = 0;
    outcome = { ok: true, model: null, effort: null };
    expect(await (await post("/api/agents/laptop:api/restart", { model: null, effort: "", ifIdle: true })).json())
      .toEqual({ ok: true, model: null, effort: null });
    expect(calls[1]!.args).toEqual(["restart", "api", "--json", "--model", "default", "--effort", "default", "--if-idle", "--local", "--exact"]);
    for (const reason of ["busy", "queued", "in_turn"]) {
      outcome = { ok: false, error: `nope (${reason})`, reason };
      const res = await post("/api/agents/laptop:api/restart", { ifIdle: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `nope (${reason})`, reason });
    }
    // A rejected model on the remote is a 400 there too.
    reply = (call) =>
      call.args[0] === "__detail"
        ? { exitCode: 0, stdout: JSON.stringify({ name: "api", restartModel: true }) }
        : { exitCode: 1, stderr: 'am: unknown codex model "gpt-nope" — known models: gpt-6-luna (see `am models`)' };
    const bad = await post("/api/agents/laptop:api/restart", { model: "gpt-nope" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain('unknown codex model "gpt-nope"');
    // An older am would restart on the old model: never sent.
    reply = () => ({ exitCode: 0, stdout: JSON.stringify({ name: "api" }) });
    capable = false;
    calls.length = 0;
    const old = await post("/api/agents/laptop:api/restart", { model: "opus" });
    expect(old.status).toBe(409);
    expect(await old.json()).toEqual({ error: "remote am too old on laptop (no restart --model)", reason: "remote_too_old" });
    expect(calls.map((c) => c.args[0])).toEqual(["__detail"]);
    expect((await post("/api/agents/laptop:api/restart", { model: 1 })).status).toBe(400);
    reply = () => ({ exitCode: 1, stderr: 'am: no local agent "api"' });
    expect((await post("/api/agents/laptop:api/restart", { model: "opus" })).status).toBe(404);
  });

  test("GET /api/hosts lists this host and the configured remotes", async () => {
    const res = await fetch(url("/api/hosts"), auth());
    const body = (await res.json()) as any;
    expect(body.local).toBe(localHostIdentity());
    expect(body.hosts.map((h: any) => h.name)).toEqual(["laptop", "box.example.com"]);
    expect(body.hosts.every((h: any) => typeof h.reachable === "boolean")).toBe(true);
  });
});

describe("models api (this host)", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let oldPath: string | undefined;

  beforeEach(() => {
    resetModelsCacheForTests();
    oldPath = process.env.PATH;
    // A fake codex that counts its probes, and a claude whose probe fails.
    process.env.PATH = `${home}:/usr/bin:/bin`;
    const catalog = JSON.stringify({ models: [{ slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }] }] });
    writeFileSync(join(home, "codex"), `#!/bin/sh\necho probe >> "$AGENTMGR_HOME/probes"\nprintf '%s' '${catalog}'\n`);
    chmodSync(join(home, "codex"), 0o755);
    writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(home, "claude"), 0o755);
    const spawn = Bun.spawnSync.bind(Bun);
    spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) => spawn(cmd, { ...opts, env: { ...process.env, ...opts?.env } }));
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    process.env.PATH = oldPath;
  });

  const probes = () => (existsSync(join(home, "probes")) ? readFileSync(join(home, "probes"), "utf8").trim().split("\n").length : 0);

  test("returns the am models --json shape, cached until refresh=1", async () => {
    const res = await fetch(url("/api/models"), auth());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { provider: "codex", models: [{ id: "gpt-6-luna", efforts: ["low"] }], efforts: ["low"], modelsExhaustive: true, effortsExhaustive: true },
    ]);
    await fetch(url("/api/models"), auth());
    await fetch(url(`/api/models?host=${localHostIdentity()}`), auth());
    expect(probes()).toBe(1);
    await fetch(url("/api/models?refresh=1"), auth());
    expect(probes()).toBe(2);
  });

  test("health advertises models", async () => {
    expect(((await (await fetch(url("/api/health"), auth())).json()) as any).models).toBe(true);
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


describe("subagent API", () => {
  test("lists built-in records without pretending dead-session children are running", async () => {
    seedAgent("parent");
    recordSubagentStart("parent", { id: "child-1", type: "reviewer" });
    const result = await fetch(url("/api/agents/parent/subagents"), auth());
    expect(result.status).toBe(200);
    expect((await result.json()).records[0]).toMatchObject({ id: "child-1", stale: true });
    expect((await fetch(url("/api/agents/missing/subagents"), auth())).status).toBe(404);
  });
  test("reads a completed built-in transcript and rejects invalid selectors", async () => {
    seedAgent("parent");
    const agent = readAgent("parent")!;
    writeAgent({ ...agent, provider: "claude" });
    const file = join(home, "child-transcript.jsonl");
    writeFileSync(file, JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"Child result"}]}}) + "\n");
    recordSubagentStart("parent", { id: "child-1", type: "reviewer" });
    recordSubagentStop("parent", { id: "child-1", transcriptPath: file });
    const response = await fetch(url("/api/agents/parent/transcript?subagent=child-1"), auth());
    expect(response.status).toBe(200);
    expect((await response.json()).entries[0].text).toBe("Child result");
    expect((await fetch(url("/api/agents/parent/transcript?subagent=../../etc/passwd"), auth())).status).toBe(400);
    expect((await fetch(url("/api/agents/parent/transcript?subagent=unknown"), auth())).status).toBe(409);
    expect((await fetch(url("/api/agents/parent/subagents"))).status).toBe(401);
  });
});

test("conversation search requires authentication, validates query and federates literal stdin", async () => {
  expect((await fetch(url("/api/search"), { method: "POST", body: JSON.stringify({ query: "needle" }) })).status).toBe(401);
  expect((await fetch(url("/api/search"), auth({ method: "POST", body: JSON.stringify({ query: "a" }) }))).status).toBe(400);
  writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["laptop"] }));
  const calls: any[] = [];
  setRemoteRunnersForTests({ am: async (host, args, opts) => {
    calls.push({ host, args, opts });
    return { exitCode: 0, stderr: "", stdout: JSON.stringify({ matches: [{ name: "child", snippets: [{ kind: "assistant", text: "--needle <script>literal</script>" }] }], partial: false }) };
  } });
  try {
    const response = await fetch(url("/api/search"), auth({ method: "POST", body: JSON.stringify({ query: "--needle" }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).matches[0]).toMatchObject({ name: "child", host: "laptop" });
    expect(calls[0].args).toEqual(["__web-search", "--local", "--exact"]);
    expect(calls[0].opts.stdin).toBe(JSON.stringify("--needle"));
  } finally { setRemoteRunnersForTests(); }
});
