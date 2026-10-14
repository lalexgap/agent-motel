import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexDaemonEnv, stopCodexThread, trustCodexDir } from "../src/codexDaemon";

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
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SOMETHING_NEW: "1",
      CLAUDE_EFFORT: "high",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me" });
  });
});
