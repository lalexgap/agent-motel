import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { readAgent, writeAgent } from "../src/state";
import { createWebTerminal, TerminalConnection, terminalTarget, terminalAttachArgv, type TerminalTarget } from "../src/webTerminal";

import { setRemoteRunnersForTests } from "../src/remoteAgents";

const origin = "https://am.example.test";
const token = "terminal-test-token-long-enough";
let server: ApiServerHandle;
let home: string;
let cookie: string;
let sessions: string[];
let sockets: WebSocket[];
const delay = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(20); }
  throw new Error("Condition timed out");
}
function tmux(...args: string[]) { return Bun.spawnSync(["tmux", ...args]); }
function seed(name: string, status: "idle" | "exited" = "idle", session?: string) {
  const now = new Date().toISOString();
  writeAgent({ name, status, dir: "/tmp", tmuxSession: session ?? `am-terminal-test-${process.pid}-${name}`, createdAt: now, updatedAt: now });
}
function live(name: string) {
  const session = `am-terminal-test-${process.pid}-${name}`;
  const result = tmux("new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat");
  expect(result.exitCode).toBe(0);
  sessions.push(session);
  seed(name, "idle", session);
  return session;
}
async function connect(name: string) {
  const ws = new WebSocket(server.url.replace("http:", "ws:") + `/api/agents/${name}/terminal`, { headers: { cookie, origin } });
  sockets.push(ws);
  const controls: any[] = [];
  let output = "";
  ws.binaryType = "arraybuffer";
  ws.onmessage = event => {
    if (typeof event.data === "string") controls.push(JSON.parse(event.data));
    else output += new TextDecoder().decode(event.data);
  };
  await until(() => controls.some(x => x.type === "ready"));
  return { ws, controls, output: () => output };
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "am-terminal-"));
  process.env.AGENTMGR_HOME = home;
  sessions = []; sockets = [];
  server = startApiServer({ port: 0, hostname: "127.0.0.1", token, webOrigin: origin });
  const response = await fetch(server.url + "/auth/login", { method: "POST", headers: { origin }, body: JSON.stringify({ token }) });
  cookie = response.headers.get("set-cookie")!.split(";")[0]!;
});
afterEach(() => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const session of sessions) tmux("kill-session", "-t", `=${session}`);
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  setRemoteRunnersForTests();
});

describe("terminal route security", () => {
  test("rejects no auth, wrong/missing origin, bearer-only and URL credentials", async () => {
    const path = server.url + "/api/agents/test/terminal";
    expect((await fetch(path, { headers: { origin } })).status).toBe(401);
    for (const headers of [{ cookie }, { cookie, origin: "https://evil.test" }, { cookie, origin: "null" }] as Record<string, string>[])
      expect((await fetch(path, { headers })).status).toBe(403);
    expect((await fetch(path, { headers: { authorization: `Bearer ${token}`, origin } })).status).toBe(401);
    expect((await fetch(path + "?cookie=" + cookie, { headers: { cookie, origin } })).status).toBe(400);
    expect((await fetch(path + "?token=" + token, { headers: { origin } })).status).toBe(401);
  });
  test("rejects stopped, missing, and prefix-only sessions", async () => {
    seed("stopped", "exited"); seed("missing");
    live("prefix-long"); seed("prefix");
    for (const name of ["stopped", "missing", "prefix"])
      expect((await fetch(server.url + `/api/agents/${name}/terminal`, { headers: { cookie, origin } })).status).toBe(409);
    expect((await fetch(server.url + "/api/agents/unknown/terminal", { headers: { cookie, origin } })).status).toBe(404);
  });
  test("disabled without webOrigin", async () => {
    server.stop(); server = startApiServer({ port: 0, hostname: "127.0.0.1", token });
    expect((await fetch(server.url + "/api/agents/test/terminal", { headers: { authorization: `Bearer ${token}`, origin } })).status).toBe(403);
  });
  test("preflight resolves local and configured remote exact state", async () => {
    live("preflight");
    const request = (key: string) => fetch(server.url + `/api/agents/${key}/terminal`, { headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(await (await request("preflight")).json()).toEqual({ available: true, transport: "local" });
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["laptop"] }));
    let status = "idle", reportedName = "remote", terminalAttach = 1;
    setRemoteRunnersForTests({ am: async (host, args) => {
      expect(host).toBe("laptop");
      expect(args).toEqual(["__detail", "remote", "--local", "--exact"]);
      return { exitCode: 0, stdout: JSON.stringify({ name: reportedName, status, createdAt: "now", terminalAttach }), stderr: "" };
    } });
    expect(await (await request("laptop:remote")).json()).toEqual({ available: true, transport: "ssh" });
    terminalAttach = 0;
    const oldRemote = await request("laptop:remote");
    expect(oldRemote.status).toBe(409);
    expect((await oldRemote.json() as { error: string }).error).toContain("upgrade");
    terminalAttach = 1;
    status = "exited";
    expect((await request("laptop:remote")).status).toBe(409);
    status = "idle"; reportedName = "remote-other";
    expect((await request("laptop:remote")).status).toBe(409);
    expect((await request("unknown:remote")).status).toBe(404);
    const argv = terminalAttachArgv({ host: "laptop", name: "remote", session: "", sessionId: "", createdAt: "now" });
    expect(argv).toContain("-tt"); expect(argv).toContain("BatchMode=yes");
    expect(argv.at(-1)).toContain("--exact"); expect(argv.at(-1)).toContain("--local");
    expect(argv.at(-1)).not.toContain("new-session");
    expect(argv.at(-1)).toContain("__terminal");
    expect(argv.at(-1)).toContain("now");
  });
  test("caps remote preflight concurrency before SSH and releases completed slots", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["laptop"] }));
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    setRemoteRunnersForTests({ am: async () => {
      calls++;
      await blocked;
      return { exitCode: 0, stdout: JSON.stringify({ name: "remote", status: "idle", createdAt: "now", terminalAttach: 1 }), stderr: "" };
    } });
    const request = () => fetch(server.url + "/api/agents/laptop:remote/terminal", { headers: { cookie, origin } });
    const pending = Array.from({ length: 16 }, request);
    try {
      await until(() => calls === 16);
      expect((await request()).status).toBe(429);
      expect(calls).toBe(16);
    } finally { release(); await Promise.all(pending); }
    expect((await request()).status).toBe(200);
  });
  test("caps SSE streams and releases reservations on cancellation", async () => {
    const streams: Response[] = [];
    const controllers: AbortController[] = [];
    const request = () => {
      const controller = new AbortController();
      controllers.push(controller);
      return fetch(server.url + "/api/web-events", { headers: { cookie, origin }, signal: controller.signal });
    };
    try {
      for (let i = 0; i < 32; i++) {
        const response = await request();
        expect(response.status).toBe(200);
        streams.push(response);
      }
      expect((await request()).status).toBe(429);
      controllers[0]!.abort();
      await streams.shift()!.body!.cancel().catch(() => {});
      await delay(50);
      const admitted = await request();
      expect(admitted.status).toBe(200);
      streams.push(admitted);
    } finally { for (const controller of controllers) controller.abort(); await Promise.all(streams.map(response => response.body!.cancel().catch(() => {}))); }
  });
  test("SSE requires live cookie and origin/Fetch Metadata; logout closes stream", async () => {
    const path = server.url + "/api/web-events";
    expect((await fetch(path, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(path, { headers: { cookie, origin: "https://evil.test", "sec-fetch-site": "same-origin" } })).status).toBe(403);
    expect((await fetch(path, { headers: { authorization: `Bearer ${token}`, origin } })).status).toBe(401);
    const response = await fetch(path, { headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    await fetch(server.url + "/auth/logout", { method: "POST", headers: { origin, cookie } });
    expect((await reader.read()).done).toBe(true);
  });
});

describe("real Bun PTY", () => {
  test("attaches, delivers input, resizes, detaches without killing session", async () => {
    const session = live("interactive");
    const { ws, output } = await connect("interactive");
    ws.send(JSON.stringify({ type: "input", data: "terminal-roundtrip\n" }));
    await until(() => output().includes("terminal-roundtrip"));
    ws.send(JSON.stringify({ type: "resize", cols: 101, rows: 37 }));
    await until(() => tmux("list-clients", "-t", `=${session}`, "-F", "#{client_width}x#{client_height}").stdout.toString().trim() === "101x37");
    ws.close();
    await until(() => tmux("list-clients", "-t", `=${session}`).stdout.toString().trim() === "");
    expect(tmux("has-session", "-t", `=${session}`).exitCode).toBe(0);
  });
  test("logout closes all attached sockets and preserves agent", async () => {
    const session = live("logout");
    const a = await connect("logout"), b = await connect("logout");
    await fetch(server.url + "/auth/logout", { method: "POST", headers: { cookie, origin } });
    await until(() => a.ws.readyState === WebSocket.CLOSED && b.ws.readyState === WebSocket.CLOSED);
    expect(a.controls.some(x => x.type === "error")).toBe(true);
    expect(tmux("has-session", "-t", `=${session}`).exitCode).toBe(0);
  });
  test("expiry stops an active socket before another input write", async () => {
    live("expired");
    const { ws } = await connect("expired");
    const real = Date.now;
    Date.now = () => real() + 13 * 60 * 60 * 1000;
    try { await until(() => ws.readyState === WebSocket.CLOSED); }
    finally { Date.now = real; }
  });
  test("internal attach rejects a same-name replacement and attaches verified identity", async () => {
    const session = live("identity");
    const original = readAgent("identity")!;
    const replacement = { ...original, createdAt: "2099-01-01T00:00:00.000Z" };
    writeAgent(replacement);
    const index = new URL("../src/index.ts", import.meta.url).pathname;
    const rejected = Bun.spawn([process.execPath, index, "__terminal", "identity", original.createdAt, "--local", "--exact"], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(await rejected.exited).toBe(1);
    expect(await new Response(rejected.stderr).text()).toContain("identity changed");
    expect(tmux("list-clients", "-t", `=${session}`).stdout.toString().trim()).toBe("");
    const target = terminalTarget("identity", replacement.createdAt) as TerminalTarget;
    expect(terminalAttachArgv(target)).toEqual(["tmux", "attach-session", "-t", target.sessionId]);
    let output = "";
    const attached = Bun.spawn([process.execPath, index, "__terminal", "identity", replacement.createdAt, "--local", "--exact"], {
      env: { ...process.env, TERM: "xterm-256color", TMUX: "" },
      terminal: { data(_terminal, bytes) { output += new TextDecoder().decode(bytes); } },
    });
    try {
      await until(() => tmux("list-clients", "-t", `=${session}`).stdout.toString().trim() !== "");
      attached.terminal!.write("verified-helper-input\n");
      await until(() => output.includes("verified-helper-input"));
      tmux("detach-client", "-s", session);
      expect(await attached.exited).toBe(0);
      expect(tmux("has-session", "-t", `=${session}`).exitCode).toBe(0);
    } finally { attached.terminal!.close(); attached.kill(); }
  });
  test("missing tmux session after selection cannot attach replacement by name", () => {
    const session = live("replaced");
    const first = terminalTarget("replaced") as TerminalTarget;
    tmux("kill-session", "-t", `=${session}`);
    live("replaced");
    expect((terminalTarget("replaced") as TerminalTarget).sessionId).not.toBe(first.sessionId);
  });
});

describe("terminal limits and cleanup", () => {
  function fixture() {
    let valid = true, invalidate = () => {}, writes = 0, resizes = 0, kills = 0, closes = 0, buffered = 0;
    let output = (_bytes: Uint8Array) => {};
    const sent: unknown[] = [];
    const connection = new TerminalConnection({ send(value) { sent.push(value); return 1; }, close() {}, getBufferedAmount() { return buffered; } }, {
      isValid: () => valid, subscribe(callback) { invalidate = callback; return () => {}; },
    });
    connection.start({ name: "test", session: "test", sessionId: "$1", createdAt: "now" }, (_target, callback) => {
      output = callback;
      return { terminal: { write(bytes) { writes++; return Buffer.byteLength(bytes as Uint8Array); }, resize() { resizes++; }, close() { closes++; } }, kill() { kills++; }, exited: new Promise(() => {}) };
    });
    return { connection, sent, output: (bytes: Uint8Array) => output(bytes), revoke() { valid = false; invalidate(); }, congest() { buffered = 256 * 1024; }, counts: () => ({ writes, resizes, kills, closes }) };
  }
  test("retains the latest resize received before asynchronous attachment", async () => {
    const connection = new TerminalConnection({ send() { return 1; }, close() {}, getBufferedAmount() { return 0; } }, {
      isValid: () => true, subscribe: () => () => {},
    });
    connection.message(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await delay();
    connection.message(JSON.stringify({ type: "resize", cols: 94, rows: 31 }));
    let initialSize: unknown;
    connection.start({ name: "test", session: "test", sessionId: "$1", createdAt: "now" }, (_target, _data, size) => {
      initialSize = size;
      return { terminal: { write() { return 0; }, resize() {}, close() {} }, kill() {}, exited: new Promise(() => {}) };
    });
    expect(initialSize).toEqual({ cols: 94, rows: 31 });
    connection.close();
  });
  test("logout discards queued input synchronously and cleanup is idempotent", async () => {
    const f = fixture();
    f.connection.message(JSON.stringify({ type: "input", data: "forbidden" }));
    f.revoke();
    f.connection.message(JSON.stringify({ type: "input", data: "also forbidden" }));
    await delay(); f.connection.close();
    expect(f.counts()).toEqual({ writes: 0, resizes: 0, kills: 1, closes: 1 });
  });
  test("resize validates bounds and stops on invalid dimensions", () => {
    const f = fixture();
    f.connection.message(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    f.connection.message(JSON.stringify({ type: "resize", cols: 501, rows: 24 }));
    expect(f.counts()).toEqual({ writes: 0, resizes: 1, kills: 1, closes: 1 });
  });
  test("oversized input and slow output close the attach client", () => {
    const a = fixture(); a.connection.message(JSON.stringify({ type: "input", data: "x".repeat(16385) }));
    expect(a.counts().kills).toBe(1);
    const b = fixture(); b.congest(); b.output(new Uint8Array(1));
    expect(b.counts().kills).toBe(1);
  });
});

test("remote socket opens only connection-owned work, without a detached identity lookup", () => {
  let lookups = 0;
  setRemoteRunnersForTests({ am: async () => {
    lookups++;
    return new Promise(() => {});
  } });
  const started: TerminalTarget[] = [];
  const start = spyOn(TerminalConnection.prototype, "start").mockImplementation(target => { started.push(target); });
  const handler = createWebTerminal();
  const target = { host: "laptop", name: "remote", createdAt: "expected", session: "", sessionId: "" };
  const socket = {
    data: { target, isValid: () => true, subscribe: () => () => {} },
    send() { return 1; }, close() {}, getBufferedAmount() { return 0; },
  };
  try {
    handler.websocket.open!(socket as any);
    expect(lookups).toBe(0);
    expect(started).toEqual([target]);
    handler.websocket.close!(socket as any, 1000, "");
  } finally {
    start.mockRestore();
    handler.stop();
    setRemoteRunnersForTests();
  }
});
