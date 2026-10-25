import type { ServerWebSocket, WebSocketHandler } from "bun";
import { readAgent } from "./state";
import { tmux } from "./tmux";
import { sshAmStreamArgv } from "./remote";
import { AGENT_NAME_RE, runRemoteJson } from "./remoteAgents";

const MAX_INPUT = 16 * 1024;
const MAX_QUEUE = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;

export interface TerminalTarget {
  host?: string;
  name: string;
  createdAt: string;
  session: string;
  sessionId: string;
}

export async function remoteTerminalTarget(host: string, name: string): Promise<TerminalTarget | Response> {
  const detail = await runRemoteJson<{ name: string; status: string; createdAt: string; terminalAttach?: number }>(host, ["__detail", name]);
  if (detail.terminalAttach !== 1)
    return Response.json({ error: "Remote am needs an upgrade for identity-checked terminal attachment" }, { status: 409 });
  if (detail.name !== name || typeof detail.createdAt !== "string")
    return Response.json({ error: "Remote agent identity could not be verified" }, { status: 409 });
  if (detail.status === "exited" || detail.status === "dead")
    return Response.json({ error: "Remote agent is stopped; resume it before attaching" }, { status: 409 });
  return { host, name, createdAt: detail.createdAt, session: "", sessionId: "" };
}

export function terminalAttachArgv(target: TerminalTarget): string[] {
  if (!target.host) return ["tmux", "attach-session", "-t", target.sessionId];
  const [ssh, ...args] = sshAmStreamArgv(target.host, ["__terminal", target.name, target.createdAt, "--local", "--exact"]);
  return [ssh!, "-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-e", "none", ...args];
}

export function terminalTarget(name: string, expectedCreatedAt?: string): TerminalTarget | Response {
  if (!AGENT_NAME_RE.test(name))
    return Response.json({ error: "Invalid agent name" }, { status: 400 });
  const agent = readAgent(name);
  if (!agent || agent.name !== name)
    return Response.json({ error: "Agent no longer exists under this name" }, { status: 404 });
  if (agent.status === "exited")
    return Response.json({ error: "Agent is stopped; resume it before attaching" }, { status: 409 });
  if (expectedCreatedAt !== undefined && agent.createdAt !== expectedCreatedAt)
    return Response.json({ error: "Agent identity changed; reconnect before attaching" }, { status: 409 });
  const result = tmux("display-message", "-p", "-t", `=${agent.tmuxSession}:`, "#{session_id}");
  const sessionId = result.stdout.trim();
  if (result.exitCode !== 0 || !/^\$\d+$/.test(sessionId))
    return Response.json({ error: "Agent terminal is unavailable (tmux session missing)" }, { status: 409 });
  const current = readAgent(name);
  if (!current || current.createdAt !== agent.createdAt || current.tmuxSession !== agent.tmuxSession || current.status === "exited")
    return Response.json({ error: "Agent changed while resolving its terminal; reconnect" }, { status: 409 });
  return { name, createdAt: agent.createdAt, session: agent.tmuxSession, sessionId };
}

export async function terminalAttachCommand(name: string, expectedCreatedAt: string): Promise<number> {
  const target = terminalTarget(name, expectedCreatedAt);
  if (target instanceof Response) {
    const body = await target.json() as { error: string };
    throw new Error(body.error);
  }
  const child = Bun.spawn(terminalAttachArgv(target), {
    env: { ...process.env, TMUX: "", TERM: process.env.TERM || "xterm-256color" },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  return child.exited;
}

export interface TerminalData {
  target: TerminalTarget;
  isValid: () => boolean;
  subscribe: (invalidate: () => void) => () => void;
  connection?: TerminalConnection;
}

type Socket = Pick<ServerWebSocket<TerminalData>, "send" | "close" | "getBufferedAmount">;
export interface AttachProcess {
  terminal?: Pick<Bun.Terminal, "write" | "resize" | "close">;
  kill(signal?: number | NodeJS.Signals): void;
  exited: Promise<number>;
}
type SpawnAttach = (target: TerminalTarget, data: (bytes: Uint8Array) => void, size: { cols: number; rows: number }) => AttachProcess;

const spawnAttach: SpawnAttach = (target, data, size) => Bun.spawn(terminalAttachArgv(target), {
  env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
  terminal: { ...size, data(_terminal, bytes) { data(bytes); } },
});

export class TerminalConnection {
  private process?: AttachProcess;
  private stopped = false;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private input = Buffer.alloc(0);
  private size = { cols: 80, rows: 24 };

  constructor(private socket: Socket, private auth: Pick<TerminalData, "isValid" | "subscribe">) {
    this.unsubscribe = auth.subscribe(() => this.close(4001, "Session expired or revoked"));
  }

  start(target: TerminalTarget, spawn: SpawnAttach = spawnAttach) {
    if (!this.allowed()) return;
    try {
      this.process = spawn(target, (bytes) => {
        if (!this.allowed()) return;
        if (this.socket.getBufferedAmount() + bytes.byteLength > MAX_OUTPUT) {
          this.close(1013, "Terminal output exceeded client capacity");
          return;
        }
        if (this.socket.send(bytes) === 0) this.close(1013, "Terminal output unavailable");
      }, this.size);
      this.socket.send(JSON.stringify({ type: "ready" }));
      this.timer = setInterval(() => {
        if (!this.allowed()) return;
        if (!this.input.length) return;
        try {
          // Bun 1.3.14 returns the bytes actually written to the nonblocking PTY.
          // Retain a bounded remainder when the child cannot consume input yet.
          const chunk = this.input.subarray(0, 4096);
          const written = this.process!.terminal!.write(chunk);
          this.input = this.input.subarray(written);
        } catch { this.close(1011, "Terminal input failed"); }
      }, 10);
      this.timer.unref();
      void this.process.exited.then((code) => {
        if (this.stopped) return;
        if (this.auth.isValid()) this.socket.send(JSON.stringify({ type: "exit", code }));
        this.close(1000, "Terminal detached");
      }, () => this.close(1011, "Terminal attach failed"));
    } catch { this.close(1011, "Terminal attach failed"); }
  }

  private allowed(): boolean {
    if (this.stopped) return false;
    if (!this.auth.isValid()) {
      this.close(4001, "Session expired or revoked");
      return false;
    }
    return true;
  }

  message(raw: string | Buffer) {
    if (!this.allowed()) return;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_INPUT * 6 + 128) {
      this.close(1008, "Invalid terminal message");
      return;
    }
    try {
      const message = JSON.parse(raw);
      if (message?.type === "input" && typeof message.data === "string") {
        const bytes = Buffer.from(message.data);
        if (bytes.length > MAX_INPUT || this.input.length + bytes.length > MAX_QUEUE)
          return this.close(1008, "Terminal input limit exceeded");
        this.input = Buffer.concat([this.input, bytes]);
      } else if (message?.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)
        && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
        this.size = { cols: message.cols, rows: message.rows };
        this.process?.terminal?.resize(message.cols, message.rows);
      } else this.close(1008, "Invalid terminal message");
    } catch { this.close(1008, "Invalid terminal message"); }
  }

  close(code = 1000, message = "Terminal disconnected") {
    if (this.stopped) return;
    this.stopped = true;
    this.input = Buffer.alloc(0);
    clearInterval(this.timer);
    this.unsubscribe?.();
    // Only the attach client belongs to this connection. Never kill the session.
    try { this.process?.kill("SIGKILL"); } catch {}
    try { this.process?.terminal?.close(); } catch {}
    if (code !== 1000) this.socket.send(JSON.stringify({ type: "error", message }));
    this.socket.close(code, message);
  }
}

export function createWebTerminal() {
  const connections = new Set<TerminalConnection>();
  const websocket: WebSocketHandler<TerminalData> = {
    maxPayloadLength: MAX_INPUT * 6 + 128,
    backpressureLimit: MAX_OUTPUT,
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    open(ws) {
      const connection = new TerminalConnection(ws, ws.data);
      ws.data.connection = connection;
      connections.add(connection);
      try {
        const target = ws.data.target;
        // The remote helper checks identity inside the connection-owned SSH process.
        const current = target.host ? target : terminalTarget(target.name);
        if (current instanceof Response || current.sessionId !== target.sessionId
          || current.createdAt !== target.createdAt || current.session !== target.session) {
          connection.close(1008, "Agent changed before terminal attachment; reconnect");
          return;
        }
        connection.start(current);
      } catch {
        connection.close(1011, "Remote terminal unavailable");
      }
    },
    message(ws, message) { ws.data.connection?.message(message); },
    close(ws) {
      ws.data.connection?.close();
      if (ws.data.connection) connections.delete(ws.data.connection);
    },
  };
  return { websocket, stop() { for (const connection of connections) connection.close(1001, "Server stopping"); connections.clear(); } };
}
