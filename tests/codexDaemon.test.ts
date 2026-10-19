import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  amTrustedCodexDir,
  codexDaemonEnv,
  forgetCodexTrust,
  pretrustCodexDir,
  readCodexTrustLedger,
  releaseCodexTrust,
  startCodexThread,
  stopCodexThread,
  trustCodexDir,
  untrustCodexDir,
} from "../src/codexDaemon";
import { codexResumeDaemon } from "../src/commands/resume";
import { writeAgent, type AgentState } from "../src/state";

let dir: string | undefined;
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
  test("starts the thread with the launch settings, then names it", async () => {
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
    ]);
  });

  test("leaves permissions to config without bypass, and fails without a thread id", async () => {
    const { socket, calls } = fakeAppServer(() => ({}));
    await expect(startCodexThread({ cwd: "/work/wt", name: "worker", bypass: false }, { socket })).rejects.toThrow(/thread id/);
    expect(calls[2]).toEqual(["thread/start", { cwd: "/work/wt" }]);
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
    expect(pretrustCodexDir("/work/user", write)).toBe(true);
    expect(pretrustCodexDir("/work/untrusted", write)).toBe(true);
    expect(pretrustCodexDir("/work/a", write)).toBe(true);
    expect(writes).toEqual(["/work/untrusted", "/work/a"]);
    expect(Object.keys(readCodexTrustLedger())).toEqual(["/work/a"]);
    expect(amTrustedCodexDir("/work/a")).toBe("/work/a");
    expect(amTrustedCodexDir("/work/user")).toBeUndefined();
  });

  test("an unreadable config is never recorded", () => {
    config("not = [valid toml");
    expect(pretrustCodexDir("/work/a", ok)).toBe(true);
    expect(readCodexTrustLedger()).toEqual({});
  });

  test("forget removes am's entry, keeps a user-edited one, and retries a failed removal", () => {
    config("");
    pretrustCodexDir("/work/a", ok);
    pretrustCodexDir("/work/b", ok);
    pretrustCodexDir("/work/c", ok);
    config('[projects."/work/a"]\ntrust_level = "trusted"\n[projects."/work/b"]\ntrust_level = "trusted"\nnote = "mine"\n[projects."/work/c"]\ntrust_level = "trusted"\n');
    const removed: string[] = [];
    expect(forgetCodexTrust("/work/a", (dir) => (removed.push(dir), true))).toBe(true);
    expect(forgetCodexTrust("/work/b", (dir) => (removed.push(dir), true))).toBe(true);
    expect(forgetCodexTrust("/work/c", () => false)).toBe(false);
    expect(forgetCodexTrust("/work/user", (dir) => (removed.push(dir), true))).toBe(true);
    expect(removed).toEqual(["/work/a"]);
    expect(Object.keys(readCodexTrustLedger())).toEqual(["/work/c"]);
  });

  test("release waits for the last agent using the dir", () => {
    config("");
    pretrustCodexDir("/work/a", ok);
    config('[projects."/work/a"]\ntrust_level = "trusted"\n');
    writeAgent(codexAgent("one", { codexTrustedDir: "/work/a" }));
    writeAgent(codexAgent("two"));
    const removed: string[] = [];
    const remove = (dir: string) => (removed.push(dir), true);
    releaseCodexTrust("/work/a", "one", remove);
    expect(removed).toEqual([]);
    releaseCodexTrust("/work/a", "two", remove);
    expect(removed).toEqual([]);
    rmSync(join(home, "agents", "two.json"));
    releaseCodexTrust("/work/a", "one", remove);
    expect(removed).toEqual(["/work/a"]);
    expect(readCodexTrustLedger()).toEqual({});
  });

  test("resuming in a new dir releases the old dir's entry", () => {
    config("");
    pretrustCodexDir("/work/old", ok);
    const agent = codexAgent("mover", { dir: "/work/new", codexTrustedDir: "/work/old", codexDaemon: false });
    writeAgent(agent);
    expect(codexResumeDaemon(agent, {})).toBe(false);
    expect(agent.codexTrustedDir).toBeUndefined();
    expect(readCodexTrustLedger()).toEqual({});
  });
});
