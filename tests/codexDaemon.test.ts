import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  amTrustedCodexDir,
  codexDaemonEnv,
  codexDaemonLaunch,
  codexDaemonWanted,
  codexDeadline,
  codexDaemonSocket,
  codexPreload,
  deadlineRemaining,
  forgetCodexTrust,
  missDeadline,
  pretrustCodexDir,
  readCodexTrustLedger,
  releaseCodexTrust,
  resumeCodexThread,
  startCodexThread,
  stopCodexDaemonWork,
  stopCodexThread,
  stopCodexThreadTree,
  trustCodexDir,
  untrustCodexDir,
} from "../src/codexDaemon";
import { codexResumeDaemon } from "../src/commands/resume";
import { writeAgent, type AgentState } from "../src/state";
import { recordSubagentStart, recordSubagentStop } from "../src/subagents";

let dir: string | undefined;
const soon = () => codexDeadline(10_000);
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// A stand-in for the daemon's control socket: websocket JSON-RPC over unix.
function fakeAppServer(handle: (method: string, params: any) => unknown): { socket: string; calls: [string, any][] } {
  dir = mkdtempSync(join(tmpdir(), "am-codex-daemon-"));
  const socket = join(dir, "control.sock");
  const calls: [string, any][] = [];
  server = Bun.serve({
    unix: socket,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const msg = JSON.parse(String(data));
        calls.push([msg.method, msg.params]);
        if (msg.id === undefined) return;
        const result = handle(msg.method, msg.params);
        if (result === "hang") return;
        if (result instanceof Error) ws.send(JSON.stringify({ id: msg.id, error: { code: -1, message: result.message } }));
        else ws.send(JSON.stringify({ id: msg.id, result }));
      },
    },
  });
  return { socket, calls };
}

describe("stopCodexThread", () => {
  test("interrupts the in-progress turn and cleans background terminals", async () => {
    const { socket, calls } = fakeAppServer((method) => {
      if (method === "thread/turns/list") return { data: [{ id: "turn-7", status: "inProgress" }], nextCursor: null };
      return {};
    });
    expect(await stopCodexThread("thread-1", { socket })).toEqual({ interrupted: true, cleaned: true });
    expect(calls.map(([m]) => m)).toEqual([
      "initialize",
      "initialized",
      "thread/turns/list",
      "turn/interrupt",
      "thread/backgroundTerminals/clean",
    ]);
    expect(calls[0]![1].capabilities.experimentalApi).toBe(true);
    expect(calls[3]![1]).toEqual({ threadId: "thread-1", turnId: "turn-7" });
  });

  test("leaves a finished turn alone and tolerates errors", async () => {
    const { socket, calls } = fakeAppServer((method) => {
      if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "completed" }], nextCursor: null };
      if (method === "thread/backgroundTerminals/clean") return new Error("thread not loaded");
      return {};
    });
    expect(await stopCodexThread("thread-1", { socket })).toEqual({ interrupted: false, cleaned: false });
    expect(calls.map(([m]) => m)).not.toContain("turn/interrupt");
  });

  test("gives up on a wedged daemon", async () => {
    const { socket } = fakeAppServer((method) => (method === "initialize" ? "hang" : {}));
    await expect(stopCodexThread("thread-1", { socket, timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  test("stops the root, then the loaded threads in its tree, over one connection", async () => {
    const threads: Record<string, { sessionId: string; parentThreadId: string | null }> = {
      root: { sessionId: "root", parentThreadId: null },
      child: { sessionId: "root", parentThreadId: "root" },
      grandchild: { sessionId: "other", parentThreadId: "child" },
      // parent not loaded, but in the root's session
      orphan: { sessionId: "root", parentThreadId: "gone" },
      "other-agent": { sessionId: "other-agent", parentThreadId: null },
      "other-sub": { sessionId: "other-agent", parentThreadId: "other-agent" },
    };
    const { socket, calls } = fakeAppServer((method, params) => {
      if (method === "thread/loaded/list") {
        const ids = Object.keys(threads);
        return params.cursor ? { data: ids.slice(3), nextCursor: null } : { data: ids.slice(0, 3), nextCursor: "page-2" };
      }
      if (method === "thread/read") return { thread: { id: params.threadId, ...threads[params.threadId] } };
      if (method === "thread/turns/list") return { data: [{ id: `turn-${params.threadId}`, status: "inProgress" }], nextCursor: null };
      return {};
    });
    const results = await stopCodexThreadTree("root", ["stale-ledger-entry"], { socket });
    expect(results).toHaveLength(4);
    expect(calls.filter(([m]) => m === "initialize")).toHaveLength(1);
    expect(calls.filter(([m]) => m === "turn/interrupt").map(([, p]) => p.threadId)).toEqual(["root", "child", "grandchild", "orphan"]);
  });

  test("falls back to the ledger when loaded threads can't be listed", async () => {
    const { socket, calls } = fakeAppServer((method, params) => {
      if (method === "thread/loaded/list") return new Error("unknown method");
      if (method === "thread/turns/list") return { data: [{ id: `turn-${params.threadId}`, status: "inProgress" }], nextCursor: null };
      return {};
    });
    await stopCodexThreadTree("root", ["sub-1", "root", "sub-1"], { socket });
    expect(calls.filter(([m]) => m === "turn/interrupt").map(([, p]) => p.threadId)).toEqual(["root", "sub-1"]);
  });

  test("fails fast when nothing listens on the socket", async () => {
    await expect(stopCodexThread("thread-1", { socket: "/nonexistent/control.sock", timeoutMs: 2000 })).rejects.toThrow();
  });
});

describe("trustCodexDir", () => {
  test("upserts only this dir's project entry", async () => {
    const { socket, calls } = fakeAppServer(() => ({ status: "ok" }));
    await trustCodexDir("/work/wt", { socket });
    expect(calls[2]).toEqual([
      "config/value/write",
      { keyPath: "projects", value: { "/work/wt": { trust_level: "trusted" } }, mergeStrategy: "upsert" },
    ]);
  });
});

describe("codexDaemonEnv", () => {
  test("drops am identity and nested-session vars, keeps the rest", () => {
    const env = codexDaemonEnv({
      PATH: "/bin",
      HOME: "/home/me",
      AGENTMGR_AGENT: "spawner",
      AGENTMGR_HOME: "/x",
      CODEX_THREAD_ID: "thread-of-spawner",
      CODEX_SESSION_ID: "session-of-spawner",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SOMETHING_NEW: "1",
      CLAUDE_EFFORT: "high",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me" });
  });
});

describe("untrustCodexDir", () => {
  test("removes only this dir's project entry", async () => {
    const { socket, calls } = fakeAppServer(() => ({ status: "ok" }));
    await untrustCodexDir("/work/w.t", { socket });
    expect(calls[2]).toEqual([
      "config/value/write",
      { keyPath: 'projects."/work/w.t"', value: null, mergeStrategy: "replace" },
    ]);
  });
});

describe("startCodexThread", () => {
  test("persists fresh bypass settings before the TUI reconstructs the named thread", async () => {
    const { socket, calls } = fakeAppServer((method) => (method === "thread/start" ? { thread: { id: "thread-9" } } : {}));
    const id = await startCodexThread({ cwd: "/work/wt", name: "worker", model: "gpt-x", effort: "high", bypass: true }, { socket });
    expect(id).toBe("thread-9");
    expect(calls.slice(2)).toEqual([
      [
        "thread/start",
        {
          cwd: "/work/wt",
          model: "gpt-x",
          config: { model_reasoning_effort: "high" },
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      ],
      ["thread/name/set", { threadId: "thread-9", name: "worker" }],
      ["thread/settings/update", { threadId: "thread-9", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
    ]);
  });

  test("does not persist bypass when skipPermissions is false", async () => {
    const { socket, calls } = fakeAppServer((method) => (method === "thread/start" ? { thread: { id: "thread-9" } } : {}));
    await startCodexThread({ cwd: "/work/wt", name: "worker", bypass: false }, { socket });
    expect(calls.slice(2)).toEqual([
      ["thread/start", { cwd: "/work/wt" }],
      ["thread/name/set", { threadId: "thread-9", name: "worker" }],
    ]);
  });

  test("does not hand off an unpersisted bypass thread when settings/update fails", async () => {
    const { socket } = fakeAppServer((method) => {
      if (method === "thread/start") return { thread: { id: "thread-9" } };
      if (method === "thread/settings/update") return new Error("unsupported settings update");
      return {};
    });
    await expect(startCodexThread({ cwd: "/work/wt", name: "worker", bypass: true }, { socket })).rejects.toThrow("unsupported settings update");
  });

  test("bounds settings persistence by the same launch deadline", async () => {
    const { socket } = fakeAppServer((method) => {
      if (method === "thread/start") return { thread: { id: "thread-9" } };
      return method === "thread/settings/update" ? "hang" : {};
    });
    await expect(startCodexThread({ cwd: "/work/wt", name: "worker", bypass: true }, { socket, timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  test("leaves permissions to config without bypass, and fails without a thread id", async () => {
    const { socket, calls } = fakeAppServer(() => ({}));
    await expect(startCodexThread({ cwd: "/work/wt", name: "worker", bypass: false }, { socket })).rejects.toThrow(/thread id/);
    expect(calls[2]).toEqual(["thread/start", { cwd: "/work/wt" }]);
  });
});

describe("resumeCodexThread", () => {
  const loadedServer = (loaded: string[], probe: Record<string, unknown> = {}) =>
    fakeAppServer((method) => {
      if (method === "thread/loaded/list") return { data: loaded, nextCursor: null };
      if (method === "thread/resume") return { thread: { id: "thread-9" }, cwd: "/work/wt" };
      if (method === "thread/start") return { thread: { id: "probe-1" }, ...probe };
      return {};
    });

  test("loads an unloaded thread with bypass permissions", async () => {
    const { socket, calls } = loadedServer([]);
    await resumeCodexThread("thread-9", { bypass: true }, { socket });
    expect(calls.slice(3)).toEqual([
      ["thread/resume", { threadId: "thread-9", excludeTurns: true, approvalPolicy: "never", sandbox: "danger-full-access" }],
    ]);
  });

  test("loads an unloaded thread with config's permissions without bypass", async () => {
    const { socket, calls } = loadedServer([]);
    await resumeCodexThread("thread-9", { bypass: false }, { socket });
    expect(calls.slice(3)).toEqual([["thread/resume", { threadId: "thread-9", excludeTurns: true }]]);
  });

  test("replaces a loaded thread's settings with bypass", async () => {
    const { socket, calls } = loadedServer(["thread-9"]);
    await resumeCodexThread("thread-9", { bypass: true }, { socket });
    expect(calls.at(-1)).toEqual([
      "thread/settings/update",
      { threadId: "thread-9", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    ]);
  });

  test("puts a loaded thread back on codex's defaults for its dir without bypass", async () => {
    const { socket, calls } = loadedServer(["thread-9"], {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
      activePermissionProfile: { id: ":workspace", extends: null },
    });
    await resumeCodexThread("thread-9", { bypass: false }, { socket });
    expect(calls.slice(4)).toEqual([
      ["thread/start", { cwd: "/work/wt", ephemeral: true }],
      ["thread/unsubscribe", { threadId: "probe-1" }],
      ["thread/settings/update", { threadId: "thread-9", approvalPolicy: "on-request", permissions: ":workspace" }],
    ]);
  });

  test("carries the agent's model and effort to an unloaded thread and onto a loaded one", async () => {
    const unloaded = loadedServer([]);
    await resumeCodexThread("thread-9", { bypass: true, model: "gpt-6.1-sol", effort: "high" }, { socket: unloaded.socket });
    expect(unloaded.calls.slice(3)).toEqual([
      ["thread/resume", {
        threadId: "thread-9",
        excludeTurns: true,
        model: "gpt-6.1-sol",
        config: { model_reasoning_effort: "high" },
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }],
    ]);
    server?.stop(true);
    const loaded = loadedServer(["thread-9"]);
    await resumeCodexThread("thread-9", { bypass: true, model: "gpt-6.1-sol", effort: "high" }, { socket: loaded.socket });
    expect(loaded.calls.at(-1)).toEqual([
      "thread/settings/update",
      { threadId: "thread-9", model: "gpt-6.1-sol", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    ]);
  });

  test("falls back to the sandbox policy when no profile is reported", async () => {
    const { socket, calls } = loadedServer(["thread-9"], { approvalPolicy: "untrusted", sandbox: { type: "readOnly", networkAccess: false } });
    await resumeCodexThread("thread-9", { bypass: false }, { socket });
    expect(calls.at(-1)).toEqual([
      "thread/settings/update",
      { threadId: "thread-9", approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } },
    ]);
  });
});

describe("codex deadlines", () => {
  test("a sub-deadline never outlasts its parent, and a miss stops both", () => {
    const parent = codexDeadline(1000);
    const child = codexDeadline(60_000, parent);
    expect(deadlineRemaining(child)).toBeLessThanOrEqual(1000);
    expect(codexDeadline(100, parent).at).toBeLessThan(parent.at);
    missDeadline(child);
    expect(deadlineRemaining(child)).toBe(0);
    expect(deadlineRemaining(parent)).toBe(0);
    expect(codexDeadline(5000, parent).missed).toBe(true);
  });

  test("a missed deadline launches in-process without touching the daemon", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const deadline = codexDeadline(10_000);
      missDeadline(deadline);
      const started = Date.now();
      expect(codexDaemonLaunch(true, "/work/wt", deadline)).toBe(false);
      expect(Date.now() - started).toBeLessThan(200);
      expect(String(errors.mock.calls[0]?.[0])).toContain("didn't respond in time");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("codexDaemonWanted", () => {
  test("a resume without a thread id launches in-process, with a note", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(codexDaemonWanted(false, true)).toBe(false);
      expect(codexDaemonWanted(true, false)).toBe(true);
      expect(errors).not.toHaveBeenCalled();
      expect(codexDaemonWanted(true, true)).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("in-process");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("codex trust ledger", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-codex-trust-"));
    process.env.AGENTMGR_HOME = home;
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
    delete process.env.CODEX_HOME;
  });

  const config = (text: string) => writeFileSync(join(home, "config.toml"), text);
  const ok = () => true;

  function codexAgent(name: string, extra: Partial<AgentState> = {}): AgentState {
    const now = new Date().toISOString();
    return { name, status: "exited", dir: "/work/a", tmuxSession: `agentmgr-trust-test-${name}`, provider: "codex", createdAt: now, updatedAt: now, ...extra };
  }

  test("records only entries am created", () => {
    config('[projects."/work/user"]\ntrust_level = "trusted"\n[projects."/work/untrusted"]\ntrust_level = "untrusted"\n');
    const writes: string[] = [];
    const write = (dir: string) => (writes.push(dir), true);
    expect(pretrustCodexDir("/work/user", soon(), write)).toBe(true);
    expect(pretrustCodexDir("/work/untrusted", soon(), write)).toBe(false);
    expect(pretrustCodexDir("/work/a", soon(), write)).toBe(true);
    expect(writes).toEqual(["/work/a"]);
    expect(Object.keys(readCodexTrustLedger())).toEqual(["/work/a"]);
    expect(amTrustedCodexDir("/work/a")).toBe("/work/a");
    expect(amTrustedCodexDir("/work/user")).toBeUndefined();
  });

  test("an unreadable config is never recorded", () => {
    config("not = [valid toml");
    expect(pretrustCodexDir("/work/a", soon(), ok)).toBe(true);
    expect(readCodexTrustLedger()).toEqual({});
  });

  test("forget removes am's entry, keeps a user-edited one, and retries a failed removal", () => {
    config("");
    pretrustCodexDir("/work/a", soon(), ok);
    pretrustCodexDir("/work/b", soon(), ok);
    pretrustCodexDir("/work/c", soon(), ok);
    config('[projects."/work/a"]\ntrust_level = "trusted"\n[projects."/work/b"]\ntrust_level = "trusted"\nnote = "mine"\n[projects."/work/c"]\ntrust_level = "trusted"\n');
    const removed: string[] = [];
    expect(forgetCodexTrust("/work/a", soon(), (dir) => (removed.push(dir), true))).toBe(true);
    expect(forgetCodexTrust("/work/b", soon(), (dir) => (removed.push(dir), true))).toBe(true);
    expect(forgetCodexTrust("/work/c", soon(), () => false)).toBe(false);
    expect(forgetCodexTrust("/work/user", soon(), (dir) => (removed.push(dir), true))).toBe(true);
    expect(removed).toEqual(["/work/a"]);
    expect(Object.keys(readCodexTrustLedger())).toEqual(["/work/c"]);
  });

  test("release waits for the last agent using the dir", () => {
    config("");
    pretrustCodexDir("/work/a", soon(), ok);
    config('[projects."/work/a"]\ntrust_level = "trusted"\n');
    writeAgent(codexAgent("one", { codexTrustedDir: "/work/a" }));
    writeAgent(codexAgent("two"));
    const removed: string[] = [];
    const remove = (dir: string) => (removed.push(dir), true);
    releaseCodexTrust("/work/a", "one", soon(), remove);
    expect(removed).toEqual([]);
    releaseCodexTrust("/work/a", "two", soon(), remove);
    expect(removed).toEqual([]);
    rmSync(join(home, "agents", "two.json"));
    releaseCodexTrust("/work/a", "one", soon(), remove);
    expect(removed).toEqual(["/work/a"]);
    expect(readCodexTrustLedger()).toEqual({});
  });

  test("resuming in a new dir releases the old dir's entry", () => {
    config("");
    pretrustCodexDir("/work/old", soon(), ok);
    const agent = codexAgent("mover", { dir: "/work/new", codexTrustedDir: "/work/old", codexDaemon: false });
    writeAgent(agent);
    expect(codexResumeDaemon(agent, {})).toBe(false);
    expect(agent.codexTrustedDir).toBeUndefined();
    expect(readCodexTrustLedger()).toEqual({});
  });

  test("preloads the thread with the current skipPermissions, and reports a failed load", () => {
    const loaded: [string, boolean][] = [];
    const load = (ok: boolean) => (id: string, bypass: boolean) => (loaded.push([id, bypass]), ok);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(codexPreload("thread-1", soon(), load(true))).toBe(true);
      expect(codexPreload("thread-2", soon(), load(false))).toBe(false);
      writeFileSync(join(home, "config.json"), JSON.stringify({ skipPermissions: false }));
      expect(codexPreload("thread-3", soon(), load(true))).toBe(true);
      expect(loaded).toEqual([["thread-1", true], ["thread-2", true], ["thread-3", false]]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a resume preloads the thread with the agent's saved model and effort", () => {
    const loaded: unknown[] = [];
    const agent = codexAgent("picky", { codexDaemon: true, sessionId: "thread-7", model: "gpt-6.1-sol", effort: "high" });
    writeFileSync(join(home, "config.json"), JSON.stringify({ skipPermissions: true }));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      codexPreload("thread-7", soon(), (id, bypass, settings) => (loaded.push([id, bypass, settings]), true), { model: agent.model, effort: agent.effort });
      expect(loaded).toEqual([["thread-7", true, { model: "gpt-6.1-sol", effort: "high" }]]);
    } finally {
      errors.mockRestore();
    }
  });

  test("a daemon-mode resume without a thread id launches in-process and loads nothing", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = codexAgent("nothread", { codexDaemon: true });
      const loaded: string[] = [];
      expect(codexResumeDaemon(agent, {}, soon(), (id) => (loaded.push(id), true))).toBe(false);
      expect(agent.codexDaemon).toBe(true);
      expect(agent.codexDaemonAttached).toBe(false);
      expect(loaded).toEqual([]);
      expect(String(errors.mock.calls[0]?.[0])).toContain("no codex thread id");
    } finally {
      errors.mockRestore();
    }
  });

  test("stopping an agent hands the daemon its thread plus the ledger as fallback", () => {
    mkdirSync(join(home, "app-server-control"), { recursive: true });
    writeFileSync(codexDaemonSocket(), "");
    const agent = codexAgent("boss", { codexDaemon: true, sessionId: "root" });
    recordSubagentStart("boss", { id: "sub-1" });
    recordSubagentStart("boss", { id: "sub-2" });
    recordSubagentStop("boss", { id: "sub-2" });
    recordSubagentStart("boss", { id: "sub-3" });
    const stopped: string[][] = [];
    expect(stopCodexDaemonWork(agent, soon(), (ids) => (stopped.push(ids), true))).toBe(true);
    expect(stopped).toEqual([["root", "sub-1", "sub-3"]]);
  });

  test("a wedged daemon costs one deadline, then is skipped", () => {
    // In-process, so it can't answer while the child blocks: a wedge.
    server = Bun.serve({
      unix: (mkdirSync(join(home, "app-server-control"), { recursive: true }), codexDaemonSocket()),
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: { message() {} },
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      config("");
      const agent = codexAgent("wedged", { codexDaemon: true, sessionId: "root" });
      const deadline = codexDeadline(1500);
      const started = Date.now();
      expect(stopCodexDaemonWork(agent, deadline)).toBe(false);
      expect(deadline.missed).toBe(true);
      expect(String(errors.mock.calls[0]?.[0])).toContain("didn't respond in time");
      expect(pretrustCodexDir("/work/a", deadline)).toBe(false);
      expect(forgetCodexTrust("/work/a", deadline)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      errors.mockRestore();
    }
  });
});
