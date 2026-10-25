import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { writeAgent } from "../src/state";
import { TerminalConnection, terminalTarget, terminalAttachArgv, type TerminalTarget } from "../src/webTerminal";

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
    let status = "idle", reportedName = "remote";
    setRemoteRunnersForTests({ am: async (host, args) => {
      expect(host).toBe("laptop");
      expect(args).toEqual(["__detail", "remote", "--local", "--exact"]);
      return { exitCode: 0, stdout: JSON.stringify({ name: reportedName, status, createdAt: "now" }), stderr: "" };
    } });
    expect(await (await request("laptop:remote")).json()).toEqual({ available: true, transport: "ssh" });
    status = "exited";
    expect((await request("laptop:remote")).status).toBe(409);
    status = "idle"; reportedName = "remote-other";
    expect((await request("laptop:remote")).status).toBe(409);
    expect((await request("unknown:remote")).status).toBe(404);
    const argv = terminalAttachArgv({ host: "laptop", name: "remote", session: "", sessionId: "", createdAt: "now" });
    expect(argv).toContain("-tt"); expect(argv).toContain("BatchMode=yes");
    expect(argv.at(-1)).toContain("--exact"); expect(argv.at(-1)).toContain("--local");
    expect(argv.at(-1)).not.toContain("new-session");
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
