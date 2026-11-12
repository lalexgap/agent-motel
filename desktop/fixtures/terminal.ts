// The fixture's browser sign-in and interactive terminal, mirroring src/webAuth.ts,
// src/webTerminal.ts and the terminal gate in src/server.ts: the same checks in the
// same order, statuses, error bodies, frames, limits and close codes. The fixture's
// webOrigin is its own origin (http://127.0.0.1:<port>).
//
// Behind each agent's terminal is a tiny deterministic fake shell, shared by every
// terminal attached to that agent (like a tmux pane): a prompt, echo of typed
// characters, `echo <text>`, `size` (prints "rows cols"), `clear`, `exit`, Ctrl-C,
// Ctrl-D on an empty line, Ctrl-L, Backspace, and "<cmd>: command not found".
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { FIXTURE_HOME, FIXTURE_LOCAL_HOST, type FixtureRow } from "./data";
import { json } from "./routes";

export const SESSION_COOKIE = "__Host-am_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_INPUT = 16 * 1024;
const MAX_QUEUE = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_FRAME = MAX_INPUT * 6 + 128;
const INPUT_SLICE = 4096;
const INPUT_TICK_MS = 10;
const MAX_SOCKETS = 32;
// POST /__fixture/terminal/flood: the next terminal to attach sends this much output.
export const FLOOD_BYTES = 8 * 1024 * 1024;
export const FLOOD_LINE_BYTES = 64;
// Line i of the flood, exactly FLOOD_LINE_BYTES bytes: "flood 00000000 ....\r\n".
export const floodLine = (i: number): string => `flood ${String(i).padStart(8, "0")} `.padEnd(FLOOD_LINE_BYTES - 2, ".") + "\r\n";

export interface TerminalLogEntry {
  method: string;
  path: string;
  body: unknown;
  status?: number;
  terminal?: string;
}

export function terminalPrompt(row: Pick<FixtureRow, "host" | "dir" | "repoRoot">): string {
  const dir = row.repoRoot ?? row.dir;
  const home = dir === FIXTURE_HOME || dir.startsWith(FIXTURE_HOME + "/") ? "~" + dir.slice(FIXTURE_HOME.length) : dir;
  return `keeper@${row.host ?? FIXTURE_LOCAL_HOST}:${home}$ `;
}

// src/webAuth.ts: sessions in memory, fixed TTL, revocation callbacks, a global login limit.
export class FixtureWebAuth {
  private sessions = new Map<string, number>();
  private subscribers = new Map<string, Set<() => void>>();
  private attempts: number[] = [];

  constructor(
    private readonly origin: () => string,
    private readonly token: string,
    private readonly ttlMs: number,
    private readonly log: (entry: TerminalLogEntry) => void,
  ) {}

  session(req: Request): string | undefined {
    return req.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(SESSION_COOKIE + "="))
      ?.slice(SESSION_COOKIE.length + 1);
  }
  validId(id: string | undefined): boolean {
    return !!id && (this.sessions.get(id) ?? 0) > Date.now();
  }
  valid(req: Request): boolean {
    return this.validId(this.session(req));
  }
  sameOrigin(req: Request): boolean {
    return req.headers.get("origin") === this.origin();
  }
  get size(): number {
    return [...this.sessions.keys()].filter((id) => this.validId(id)).length;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
    for (const invalidate of [...(this.subscribers.get(id) ?? [])]) invalidate();
  }
  revokeAll(): void {
    for (const id of [...this.sessions.keys()]) this.revoke(id);
  }
  // Like a restart: sessions and the login limit are forgotten (callers close the sockets).
  reset(): void {
    this.sessions.clear();
    this.subscribers.clear();
    this.attempts = [];
  }

  subscribe(id: string, onInvalidate: () => void): () => void {
    if (!this.validId(id)) {
      onInvalidate();
      return () => {};
    }
    let active = true;
    const cleanup = () => {
      active = false;
      clearTimeout(timer);
      this.subscribers.get(id)?.delete(invalidate);
      if (!this.subscribers.get(id)?.size) this.subscribers.delete(id);
    };
    const invalidate = () => {
      if (!active) return;
      cleanup();
      onInvalidate();
    };
    const timer = setTimeout(() => this.revoke(id), Math.max(0, this.sessions.get(id)! - Date.now()));
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id)!.add(invalidate);
    return cleanup;
  }

  private cookie(value: string, age: number): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
  }

  // POST /auth/login and /auth/logout. The bearer header plays no part here.
  async route(req: Request, path: string): Promise<Response | null> {
    if (path !== "/auth/login" && path !== "/auth/logout") return null;
    const reply = (response: Response) => {
      this.log({ method: req.method, path, body: null, status: response.status });
      return response;
    };
    if (req.method !== "POST") return reply(json({ error: "method not allowed" }, 405));
    if (!this.sameOrigin(req)) return reply(json({ error: "origin rejected" }, 403));
    if (path === "/auth/logout") {
      const id = this.session(req);
      if (id) this.revoke(id);
      return reply(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": this.cookie("", 0) } }));
    }
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < 60_000);
    if (this.attempts.length >= 10) {
      return reply(new Response(JSON.stringify({ error: "Too many attempts. Wait a minute." }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      }));
    }
    this.attempts.push(now);
    const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
    const supplied = typeof body?.token === "string" ? Buffer.from(body.token) : Buffer.alloc(0);
    const expected = Buffer.from(this.token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(json({ error: "Invalid access key" }, 401));
    for (const [id, expiry] of this.sessions) if (expiry <= now) this.revoke(id);
    if (this.sessions.size >= 100) this.revoke(this.sessions.keys().next().value!);
    const old = this.session(req);
    if (old) this.revoke(old);
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, now + this.ttlMs);
    return reply(new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": this.cookie(id, Math.ceil(this.ttlMs / 1000)) },
    }));
  }
}

type Socket = Pick<ServerWebSocket<unknown>, "send" | "close" | "getBufferedAmount">;

// One agent's pane. Input is a character stream (it may arrive split anywhere, or
// carry several commands at once); output goes to every attached terminal.
export class FakeShell {
  private line = "";
  // 0: plain, 1: after ESC, 2: inside a CSI/SS3 sequence.
  private escape = 0;
  private afterCR = false;
  readonly clients = new Set<TerminalSession>();
  size = { cols: 80, rows: 24 };

  constructor(readonly prompt: string) {}

  attach(client: TerminalSession): void {
    this.clients.add(client);
    this.size = { ...client.size };
    client.output(this.prompt + this.line);
  }
  detach(client: TerminalSession): void {
    this.clients.delete(client);
  }
  resized(client: TerminalSession): void {
    this.size = { ...client.size };
  }

  private emit(text: string): void {
    for (const client of this.clients) client.output(text);
  }

  write(text: string): void {
    let out = "";
    const flush = () => {
      if (out) this.emit(out);
      out = "";
    };
    for (const char of text) {
      const cr = this.afterCR;
      this.afterCR = false;
      if (this.escape === 1) {
        this.escape = char === "[" || char === "O" ? 2 : 0;
        continue;
      }
      if (this.escape === 2) {
        const code = char.codePointAt(0)!;
        if (code >= 0x40 && code <= 0x7e) this.escape = 0;
        continue;
      }
      if (char === "\x1b") this.escape = 1;
      else if (char === "\r" || char === "\n") {
        if (char === "\n" && cr) continue;
        this.afterCR = char === "\r";
        const command = this.line;
        this.line = "";
        out += "\r\n";
        const result = this.run(command);
        if (result === "exit") {
          flush();
          for (const client of [...this.clients]) client.exit(0);
          this.reset();
          return;
        }
        out += result + this.prompt;
      } else if (char === "\x7f" || char === "\b") {
        if (this.line) {
          this.line = Array.from(this.line).slice(0, -1).join("");
          out += "\b \b";
        }
      } else if (char === "\x03") {
        this.line = "";
        out += "^C\r\n" + this.prompt;
      } else if (char === "\x04") {
        if (!this.line) {
          flush();
          for (const client of [...this.clients]) client.exit(0);
          this.reset();
          return;
        }
      } else if (char === "\x0c") out += "\x1b[H\x1b[2J" + this.prompt + this.line;
      else if (char.codePointAt(0)! >= 0x20) {
        this.line += char;
        out += char;
      }
      // Tab and other control characters do nothing.
    }
    flush();
  }

  private reset(): void {
    this.line = "";
    this.escape = 0;
    this.afterCR = false;
  }

  private run(raw: string): string | "exit" {
    const line = raw.trim();
    if (!line) return "";
    const space = line.search(/\s/);
    const command = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space).trim();
    switch (command) {
      case "echo":
        return rest + "\r\n";
      case "size":
        return `${this.size.rows} ${this.size.cols}\r\n`;
      case "clear":
        return "\x1b[H\x1b[2J";
      case "exit":
        return "exit";
      default:
        return `${command}: command not found\r\n`;
    }
  }
}

// src/webTerminal.ts's TerminalConnection with the fake shell in place of the attach process.
export class TerminalSession {
  private stopped = false;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private input = Buffer.alloc(0);
  private decoder = new TextDecoder();
  private shell?: FakeShell;
  private flooding?: ReturnType<typeof setTimeout>;
  size = { cols: 80, rows: 24 };

  constructor(
    readonly id: string,
    private readonly socket: Socket,
    private readonly auth: { isValid: () => boolean; subscribe: (invalidate: () => void) => () => void },
    private readonly hooks: { log: (body: unknown) => void; closed: (session: TerminalSession) => void },
  ) {
    this.unsubscribe = auth.subscribe(() => this.close(4001, "Session expired or revoked"));
  }

  get open(): boolean {
    return !this.stopped;
  }

  start(shell: FakeShell): void {
    if (!this.allowed()) return;
    this.shell = shell;
    this.socket.send(JSON.stringify({ type: "ready" }));
    shell.attach(this);
    this.timer = setInterval(() => {
      if (!this.allowed() || !this.input.length) return;
      const chunk = this.input.subarray(0, INPUT_SLICE);
      this.input = this.input.subarray(chunk.length);
      shell.write(this.decoder.decode(chunk, { stream: true }));
    }, INPUT_TICK_MS);
  }

  // Paced by the socket's buffer, so the server's own 256 KiB limit is not what stops it:
  // the flood is for exercising the client's caps.
  flood(total = FLOOD_BYTES): void {
    let line = 0;
    const lines = Math.ceil(total / FLOOD_LINE_BYTES);
    const pump = () => {
      this.flooding = undefined;
      while (line < lines && !this.stopped) {
        if (this.socket.getBufferedAmount() + 16 * 1024 > MAX_OUTPUT / 2) {
          this.flooding = setTimeout(pump, 1);
          return;
        }
        let chunk = "";
        for (let end = Math.min(lines, line + 256); line < end; line++) chunk += floodLine(line);
        this.output(chunk);
      }
    };
    pump();
  }

  output(text: string | Uint8Array): void {
    if (!this.allowed()) return;
    const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
    if (!bytes.byteLength) return;
    if (this.socket.getBufferedAmount() + bytes.byteLength > MAX_OUTPUT) {
      this.close(1013, "Terminal output exceeded client capacity");
      return;
    }
    if (this.socket.send(bytes) === 0) this.close(1013, "Terminal output unavailable");
  }

  // The attach process ended (exit, Ctrl-D, the agent stopped or went away).
  exit(code: number): void {
    if (this.stopped) return;
    if (this.auth.isValid()) this.socket.send(JSON.stringify({ type: "exit", code }));
    this.close(1000, "Terminal detached");
  }

  private allowed(): boolean {
    if (this.stopped) return false;
    if (!this.auth.isValid()) {
      this.close(4001, "Session expired or revoked");
      return false;
    }
    return true;
  }

  message(raw: string | Buffer | Uint8Array): void {
    if (!this.allowed()) return;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_FRAME) {
      this.hooks.log({ type: "invalid", binary: typeof raw !== "string" });
      this.close(1008, "Invalid terminal message");
      return;
    }
    let message: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown } | null;
    try {
      message = JSON.parse(raw);
    } catch {
      message = null;
    }
    if (message?.type === "input" && typeof message.data === "string") {
      this.hooks.log({ type: "input", data: message.data });
      const bytes = Buffer.from(message.data);
      if (bytes.length > MAX_INPUT || this.input.length + bytes.length > MAX_QUEUE) return this.close(1008, "Terminal input limit exceeded");
      this.input = Buffer.concat([this.input, bytes]);
    } else if (
      message?.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)
      && (message.cols as number) >= 2 && (message.cols as number) <= 500 && (message.rows as number) >= 2 && (message.rows as number) <= 200
    ) {
      this.hooks.log({ type: "resize", cols: message.cols, rows: message.rows });
      this.size = { cols: message.cols as number, rows: message.rows as number };
      this.shell?.resized(this);
    } else {
      this.hooks.log({ type: "invalid", binary: false });
      this.close(1008, "Invalid terminal message");
    }
  }

  close(code = 1000, message = "Terminal disconnected"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.input = Buffer.alloc(0);
    clearInterval(this.timer);
    clearTimeout(this.flooding);
    this.unsubscribe?.();
    this.shell?.detach(this);
    this.hooks.log({ type: "close", code, reason: message });
    this.hooks.closed(this);
    try {
      if (code !== 1000) this.socket.send(JSON.stringify({ type: "error", message }));
      this.socket.close(code, message);
    } catch {}
  }

  // The client closed the socket: nothing is sent back.
  closedByClient(code: number, reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.input = Buffer.alloc(0);
    clearInterval(this.timer);
    clearTimeout(this.flooding);
    this.unsubscribe?.();
    this.shell?.detach(this);
    this.hooks.log({ type: "close", code, reason, by: "client" });
    this.hooks.closed(this);
  }
}

export interface TerminalData {
  path: string;
  row: FixtureRow;
  session: string;
  terminal?: TerminalSession;
}

export interface TerminalHost {
  websocket: WebSocketHandler<TerminalData>;
  auth: FixtureWebAuth;
  // The terminal route (preflight or upgrade). `undefined` after a successful upgrade.
  handle(req: Request, server: Server<TerminalData>, url: URL, bearerValid: boolean): Response | undefined;
  open(): { terminal: string; agent: string; cols: number; rows: number }[];
  // The agent stopped, moved or was removed: its attach clients exit.
  detach(row: FixtureRow): void;
  floodNext(): void;
  expire(): void;
  reset(): void;
}

export type TerminalTarget = { row: FixtureRow; transport: "local" | "ssh" } | Response;

export function createTerminalHost(options: {
  origin: () => string;
  token: string;
  sessionTtlMs?: number;
  log: (entry: TerminalLogEntry) => void;
  target: (rawKey: string) => TerminalTarget;
  keyOf: (row: FixtureRow) => string;
}): TerminalHost {
  const auth = new FixtureWebAuth(options.origin, options.token, options.sessionTtlMs ?? SESSION_TTL_MS, options.log);
  const sessions = new Set<TerminalSession>();
  let shells = new Map<FixtureRow, FakeShell>();
  let counter = 0;
  let flood = false;
  const shellOf = (row: FixtureRow) => {
    let shell = shells.get(row);
    if (!shell) shells.set(row, (shell = new FakeShell(terminalPrompt(row))));
    return shell;
  };

  const websocket: WebSocketHandler<TerminalData> = {
    maxPayloadLength: MAX_FRAME,
    backpressureLimit: MAX_OUTPUT,
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    open(ws) {
      const data = ws.data;
      const id = `t${++counter}`;
      const terminal = new TerminalSession(id, ws, {
        isValid: () => auth.validId(data.session),
        subscribe: (invalidate) => auth.subscribe(data.session, invalidate),
      }, {
        log: (body) => options.log({ method: "WS", path: data.path, body, terminal: id }),
        closed: (session) => sessions.delete(session),
      });
      data.terminal = terminal;
      sessions.add(terminal);
      options.log({ method: "UPGRADE", path: data.path, body: null, status: 101, terminal: id });
      // Re-resolved on open, like a local target in src/webTerminal.ts.
      const current = options.target(encodeURIComponent(options.keyOf(data.row)));
      if (current instanceof Response || current.row !== data.row) {
        terminal.close(1008, "Agent changed before terminal attachment; reconnect");
        return;
      }
      terminal.start(shellOf(data.row));
      if (flood && terminal.open) {
        flood = false;
        terminal.flood();
      }
    },
    message(ws, message) {
      ws.data.terminal?.message(message);
    },
    close(ws, code, reason) {
      ws.data.terminal?.closedByClient(code, reason);
    },
  };

  function handle(req: Request, server: Server<TerminalData>, url: URL, bearerValid: boolean): Response | undefined {
    const path = url.pathname;
    const upgrading = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const kind = upgrading ? "UPGRADE" : req.method;
    const reply = (response: Response) => {
      options.log({ method: kind, path, body: null, status: response.status });
      return response;
    };
    // The general /api gate first: a bearer or a session.
    if (!bearerValid && !auth.valid(req)) return reply(json({ error: "unauthorized" }, 401));
    if (!bearerValid && req.method !== "GET" && req.method !== "HEAD" && !auth.sameOrigin(req)) return reply(json({ error: "origin rejected" }, 403));
    if (upgrading || req.headers.has("origin") ? !auth.sameOrigin(req) : req.headers.get("sec-fetch-site") !== "same-origin")
      return reply(json({ error: "origin rejected" }, 403));
    // A valid bearer is not enough: terminals need a revocable browser session.
    if (!auth.valid(req)) return reply(json({ error: "Web terminal requires a browser session" }, 401));
    if (req.method !== "GET") return reply(json({ error: "method not allowed" }, 405));
    if (url.search) return reply(json({ error: "Terminal URL must not contain query parameters" }, 400));
    const raw = path.split("/").filter(Boolean)[2]!;
    if (upgrading && sessions.size >= MAX_SOCKETS) return reply(json({ error: "Too many terminal requests" }, 429));
    const target = options.target(raw);
    if (target instanceof Response) return reply(target);
    if (!auth.valid(req)) return reply(json({ error: "Session expired or revoked" }, 401));
    if (!upgrading) return reply(json({ available: true, transport: target.transport }));
    if (sessions.size >= MAX_SOCKETS) return reply(json({ error: "Too many terminal connections" }, 429));
    if (server.upgrade(req, { data: { path, row: target.row, session: auth.session(req)! } })) return undefined;
    return reply(json({ error: "WebSocket upgrade required" }, 426));
  }

  function closeAll(code: number, reason: string): void {
    for (const session of [...sessions]) session.close(code, reason);
    sessions.clear();
  }

  return {
    websocket,
    auth,
    handle,
    open: () =>
      [...sessions].map((session) => {
        const row = [...shells.entries()].find(([, shell]) => shell.clients.has(session))?.[0];
        return { terminal: session.id, agent: row ? options.keyOf(row) : "", cols: session.size.cols, rows: session.size.rows };
      }),
    detach(row) {
      const shell = shells.get(row);
      if (!shell) return;
      for (const client of [...shell.clients]) client.exit(0);
      shells.delete(row);
    },
    floodNext() {
      flood = true;
    },
    expire() {
      // Revocation closes every terminal with 4001 through its subscription.
      auth.revokeAll();
    },
    reset() {
      // Like a restart: sockets close with 1001, sessions and the login limit are forgotten.
      closeAll(1001, "Server stopping");
      auth.reset();
      shells = new Map();
      counter = 0;
      flood = false;
    },
  };
}
