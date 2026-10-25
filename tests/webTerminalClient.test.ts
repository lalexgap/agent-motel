import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

async function client() {
  const sockets: any[] = [], writes: (() => void)[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    onopen?: () => void;
    onmessage?: (event: { data: ArrayBuffer }) => void;
    constructor() { sockets.push(this); }
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
    window, Terminal, FitAddon: { FitAddon: class { fit() {} } }, WebSocket: Socket,
    ResizeObserver: class { observe() {} disconnect() {} }, URL, ArrayBuffer, Uint8Array,
    location: { href: "https://am.test/", protocol: "https:" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ available: true }) }),
    setTimeout, clearTimeout,
  });
  const status = { textContent: "" };
  const controller = window.createAgentTerminal({
    screen: { clientWidth: 800, clientHeight: 400, replaceChildren() {} }, status,
    onUnauthorized() { throw new Error("unexpected logout"); },
  });
  controller.open("agent", "idle");
  await Bun.sleep(0);
  const socket = sockets[0];
  socket.onopen();
  return { controller, socket, status, writes };
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
});
