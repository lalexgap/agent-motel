import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

async function client(transport: Record<string, unknown> = {}) {
  const sockets: any[] = [], writes: (() => void)[] = [], fetches: string[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    binaryType = "blob";
    onopen?: () => void;
    onmessage?: (event: { data: ArrayBuffer }) => void;
    constructor(readonly url?: URL) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  class Terminal {
    cols = 80; rows = 24;
    loadAddon() {} open() {} onData() {} reset() {} dispose() {} focus() {}
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    write(_data: Uint8Array, done: () => void) { writes.push(done); }
  }
  const window: any = {};
  runInNewContext(readFileSync(new URL("../web/terminal.js", import.meta.url), "utf8"), {
    window, Terminal, WebLinksAddon: { WebLinksAddon: class {} }, FitAddon: { FitAddon: class { fit() {} } }, WebSocket: Socket,
    ResizeObserver: class { observe() {} disconnect() {} }, URL, ArrayBuffer, Uint8Array,
    location: { href: "https://am.test/", protocol: "https:" },
    fetch: async (path: string) => { fetches.push(path); return { ok: true, status: 200, json: async () => ({ available: true }) }; },
    setTimeout, clearTimeout,
  });
  const status = { textContent: "" };
  const controller = window.createAgentTerminal({
    screen: { clientWidth: 800, clientHeight: 400, replaceChildren() {} }, status,
    onUnauthorized() { throw new Error("unexpected logout"); },
    ...transport,
  });
  controller.open("agent/1", "idle");
  await Bun.sleep(0);
  const socket = sockets[0];
  socket?.onopen();
  return { controller, socket, status, writes, fetches };
}

describe("browser terminal transport", () => {
  test("preserves supplementary Unicode across input chunk boundaries", async () => {
    const { controller, socket } = await client();
    const input = "a".repeat(2047) + "🧗" + "b".repeat(2048);
    controller.input(input);
    const messages = socket.sent.map(JSON.parse).filter((message: any) => message.type === "input");
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.map((message: any) => Buffer.from(message.data).toString("utf8")).join("")).toBe(input);
    controller.close();
  });
  test("disconnects a stream that outpaces rendering without waiting for xterm's large buffer", async () => {
    const { controller, socket, status } = await client();
    for (let i = 0; i < 5; i++) socket.onmessage({ data: new ArrayBuffer(256 * 1024) });
    expect(socket.closed).toBe(true);
    expect(status.textContent).toContain("rendering capacity");
    controller.close();
  });
  test("completed renders release the browser output budget", async () => {
    const { controller, socket, writes } = await client();
    for (let i = 0; i < 8; i++) {
      socket.onmessage({ data: new ArrayBuffer(256 * 1024) });
      writes.shift()!();
    }
    expect(socket.closed).toBe(false);
    controller.close();
  });
  test("by default preflights over HTTP and opens a same-origin WebSocket", async () => {
    const { controller, socket, fetches, status } = await client();
    expect(fetches).toEqual(["/api/agents/agent%2F1/terminal"]);
    expect(String(socket.url)).toBe("wss://am.test/api/agents/agent%2F1/terminal");
    expect(socket.binaryType).toBe("arraybuffer");
    expect(status.textContent).toBe("● Live terminal");
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
    controller.close();
  });
  test("an injected transport replaces the preflight and the WebSocket", async () => {
    const opened: string[] = [], checked: string[] = [];
    const custom = { readyState: 1, sent: [] as string[], closed: false, send(data: string) { this.sent.push(data); }, close() { this.closed = true; } } as any;
    const { controller, socket, fetches, status } = await client({
      preflight: async (name: string) => { checked.push(name); return { ok: true, status: 200 }; },
      connect: (name: string) => { opened.push(name); return custom; },
    });
    expect(socket).toBeUndefined();
    expect(fetches).toEqual([]);
    expect([checked, opened]).toEqual([["agent/1"], ["agent/1"]]);
    custom.onopen();
    expect(status.textContent).toBe("● Live terminal");
    controller.input("ls\r");
    custom.onmessage({ data: JSON.stringify({ type: "ready" }) });
    expect(custom.sent.map(JSON.parse)).toEqual([
      { type: "resize", cols: 80, rows: 24 }, { type: "input", data: "ls\r" }, { type: "resize", cols: 80, rows: 24 },
    ]);
    custom.onclose({ code: 1000, reason: "" });
    expect(status.textContent).toBe("Terminal detached · Reconnect to attach");
    controller.close();
  });
  test("an injected preflight's error and 401 are reported like the server's", async () => {
    const { status } = await client({ preflight: async () => ({ ok: false, status: 404, error: "Agent not found" }), connect: () => { throw new Error("unexpected connect"); } });
    expect(status.textContent).toBe("Agent not found");
    let signedOut = false;
    const { controller } = await client({
      preflight: async () => ({ ok: false, status: 401 }), connect: () => { throw new Error("unexpected connect"); },
      onUnauthorized: () => { signedOut = true; },
    });
    expect(signedOut).toBe(true);
    controller.close();
  });
});
