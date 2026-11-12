// The terminal's pure parts: which view the open agent shows, whether its
// terminal should be open, and the mapping between the shared browser client's
// WebSocket-shaped protocol and the bridge's terminal methods and events.

export type AgentViewMode = "chat" | "terminal";
export const parseAgentViewMode = (raw: string | null): AgentViewMode => (raw === "terminal" ? "terminal" : "chat");

export const STOPPED_STATUSES: ReadonlySet<string> = new Set(["exited", "dead"]);

export type TerminalPlan = { kind: "closed" } | { kind: "open" | "stopped"; key: string; status: string };

// The terminal is open only while the fleet screen shows the open agent's chat
// view in Terminal mode; anything else closes it.
export function terminalPlan(input: {
  screen: string;
  mainView: string | null;
  mode: AgentViewMode;
  selected: string | null;
  connectionKnown: boolean;
  status: string | undefined;
}): TerminalPlan {
  const { selected } = input;
  if (input.screen !== "fleet" || input.mainView !== "chat" || input.mode !== "terminal" || !selected || !input.connectionKnown)
    return { kind: "closed" };
  const status = input.status ?? "";
  return { kind: STOPPED_STATUSES.has(status) ? "stopped" : "open", key: selected, status };
}
export const planSignature = (plan: TerminalPlan): string => (plan.kind === "closed" ? "closed" : `${plan.kind}:${plan.key}`);

// What the shared client sends through its socket, checked before it becomes a
// bridge call. Sizes are clamped to the bridge's limits (the client caps the top).
export type ClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
export function parseClientMessage(raw: string): ClientMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const { type, data, cols, rows } = message as Record<string, unknown>;
  if (type === "input") return typeof data === "string" && data ? { type, data } : null;
  if (type === "resize" && Number.isInteger(cols) && Number.isInteger(rows))
    return { type, cols: Math.min(500, Math.max(2, cols as number)), rows: Math.min(200, Math.max(2, rows as number)) };
  return null;
}

export const OUTPUT_LIMIT_TEXT = "Output exceeded rendering capacity · Reconnect to resume";
export const CONSENT_DECLINED_TEXT = "Terminal access was not allowed";
export const SESSION_EXPIRED_TEXT = "Session expired · Reconnect to sign in again";
export const STOPPED_TEXT = "Agent stopped · Resume to open its terminal";

// The close the client sees. 1008 is the client's "show the reason, don't
// retry" code: a refused open and the shell's output cap use it, so neither a
// declined consent nor a flood turns into an automatic reconnect loop.
export function clientClose(code: number, reason: string): { code: number; reason: string } {
  if (code === 1013) return { code: 1008, reason: OUTPUT_LIMIT_TEXT };
  return { code, reason };
}
export const refusedOpen = (message: string): { code: number; reason: string } => ({ code: 1008, reason: message || "Terminal unavailable" });

// Output arrives as base64; decode straight into the buffer xterm writes.
export function decodeBase64(data: string): ArrayBuffer {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
  if (fromBase64) {
    const bytes = fromBase64(data);
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.slice().buffer as ArrayBuffer);
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

// ⌃⇧` moves focus between the terminal and the sidebar list. By physical key,
// so the shifted character (~ on US layouts) doesn't matter.
export const isFocusChord = (event: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; altKey: boolean }): boolean =>
  event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && (event.code === "Backquote" || event.key === "`" || event.key === "~");

// A 4001 close (the server forgot the session) reopens the terminal once on
// its own; a second one within this window waits for the Reconnect button.
export const REAUTH_WINDOW_MS = 30_000;
export const mayReopen = (lastReopen: number, now: number): boolean => now - lastReopen >= REAUTH_WINDOW_MS;

// The status line's button: hidden while live, connecting or for a stopped agent.
export function retryControl(status: string, declined: boolean): { hidden: boolean; label: string } {
  const busy = status.startsWith("●") || status === "Connecting…" || status === "Reconnecting…" || status === STOPPED_TEXT || !status;
  return { hidden: busy, label: declined && status === CONSENT_DECLINED_TEXT ? "Ask again" : "Reconnect" };
}

// Input and resizes go out one bridge call at a time so they arrive in the
// order typed (the dev bridge's HTTP calls could otherwise overtake each
// other). Input typed while a call is in flight joins the next queued input,
// up to MERGE_LIMIT UTF-16 units (at most 12 KiB of UTF-8, under the bridge's 16 KiB).
export const MERGE_LIMIT = 4096;
export class OrderedSender {
  private queue: ClientMessage[] = [];
  private busy = false;
  private stopped = false;
  constructor(private readonly deliver: (message: ClientMessage) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}

  push(message: ClientMessage): void {
    if (this.stopped) return;
    const last = this.queue.at(-1);
    if (message.type === "input" && last?.type === "input" && last.data.length + message.data.length <= MERGE_LIMIT) last.data += message.data;
    else this.queue.push(message.type === "input" ? { ...message } : message);
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  get pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.queue.length) {
        const next = this.queue.shift()!;
        try {
          await this.deliver(next);
        } catch (error) {
          if (!this.stopped) this.onError(error);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

// What the socket needs from the bridge (terminal.open/input/resize/close).
export interface TerminalBridge {
  open(connection: string, agent: string): Promise<{ id?: unknown; cancelled?: unknown }>;
  input(id: string, data: string): Promise<unknown>;
  resize(id: string, cols: number, rows: number): Promise<unknown>;
  close(id: string): Promise<unknown>;
  warn(message: string, error: unknown): void;
  // The open came back with consent declined.
  declined(): void;
}

// The WebSocket-shaped object web/terminal.js drives, backed by the bridge.
// `terminal.open` stands in for the handshake (consent, sign-in, preflight and
// upgrade happen in the bridge); the bridge's events arrive through the
// router, keyed by terminal id.
export class BridgeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  private id: string | null = null;
  private done = false;
  // The id this socket's own close() closed.
  closedId: string | null = null;
  private readonly sender: OrderedSender;

  constructor(private readonly bridge: TerminalBridge, private readonly opens: TerminalOpens, connection: string, agent: string) {
    this.sender = new OrderedSender(
      (message) => message.type === "input" ? bridge.input(this.id!, message.data) : bridge.resize(this.id!, message.cols, message.rows),
      (error) => bridge.warn("terminal message failed", error),
    );
    opens.request(this, connection, agent);
  }

  // The open this socket owns settled (TerminalOpens calls it only for the
  // owner, which is never a socket the client already closed).
  settle(outcome: OpenOutcome): boolean {
    if (this.done) return false;
    if ("error" in outcome) {
      this.finish(refusedOpen(outcome.error));
      return false;
    }
    if ("cancelled" in outcome) {
      this.bridge.declined();
      this.finish(refusedOpen(CONSENT_DECLINED_TEXT));
      return false;
    }
    this.id = outcome.id;
    this.readyState = 1;
    this.onopen?.();
    // The client may have closed it from onopen; then the id is closed instead.
    return !this.done;
  }

  send(data: string): void {
    if (this.done || !this.id) return;
    const message = parseClientMessage(data);
    if (message) this.sender.push(message);
  }

  // The client's close: no onclose follows (the client has already let go).
  // An open still in flight is handed back to TerminalOpens, for the client's
  // next socket for the same agent or, if none comes, to be closed when it lands.
  close(): void {
    if (this.done) return;
    this.done = true;
    this.readyState = 3;
    this.sender.stop();
    if (!this.id) {
      this.opens.abandon(this);
      return;
    }
    this.opens.router.detach(this.id);
    this.closedId = this.id;
    this.bridge.close(this.id).catch((error: unknown) => this.bridge.warn("terminal.close failed", error));
  }

  output(data: string): void {
    if (!this.done) this.onmessage?.({ data: decodeBase64(data) });
  }
  control(message: unknown): void {
    if (!this.done) this.onmessage?.({ data: JSON.stringify(message) });
  }
  // The bridge closed it; the id is dead.
  closed(code: number, reason: string): void {
    if (!this.done) this.finish(clientClose(code, reason));
  }

  private finish(event: { code: number; reason: string }): void {
    this.done = true;
    this.readyState = 3;
    this.sender.stop();
    if (this.id) this.opens.router.detach(this.id);
    this.onclose?.(event);
  }
}

export type TerminalEvent =
  | { name: "output"; id: string; data: string }
  | { name: "control"; id: string; message: unknown }
  | { name: "closed"; id: string; code: number; reason: string };

// Routes the bridge's terminal events to live sockets. An event for an id not
// known yet is held while any open is in flight (its reply may still be on the
// way) and replayed in order when that open attaches the id; held events no
// open claims are dropped once no open is in flight. Events for any other id
// (a closed terminal, one from before a reload) are ignored.
export class TerminalRouter {
  private readonly live = new Map<string, BridgeSocket>();
  private held = new Map<string, TerminalEvent[]>();
  private inFlight = 0;

  get size(): number {
    return this.live.size;
  }
  has(id: string): boolean {
    return this.live.has(id);
  }
  heldCount(): number {
    let count = 0;
    for (const events of this.held.values()) count += events.length;
    return count;
  }

  // Call when an open starts; the returned function ends it, attaching `socket`
  // to `id` (replaying held events) or, with null, discarding what `id` held.
  opening(): (socket: BridgeSocket | null, id?: string) => void {
    this.inFlight++;
    let ended = false;
    return (socket, id) => {
      if (ended) return;
      ended = true;
      this.inFlight--;
      const events = id ? this.held.get(id) ?? [] : [];
      if (id) this.held.delete(id);
      if (socket && id) {
        this.live.set(id, socket);
        for (const event of events) {
          if (this.live.get(id) !== socket) break;
          this.deliver(socket, event);
        }
      }
      if (!this.inFlight) this.held.clear();
    };
  }

  detach(id: string): void {
    this.live.delete(id);
  }

  dispatch(event: TerminalEvent): void {
    const socket = this.live.get(event.id);
    if (socket) return this.deliver(socket, event);
    if (!this.inFlight) return;
    const list = this.held.get(event.id) ?? [];
    list.push(event);
    this.held.set(event.id, list);
  }

  private deliver(socket: BridgeSocket, event: TerminalEvent): void {
    if (event.name === "output") socket.output(event.data);
    else if (event.name === "control") socket.control(event.message);
    else socket.closed(event.code, event.reason);
  }
}

export type OpenOutcome = { id: string } | { cancelled: true } | { error: string };

interface PendingOpen {
  key: string;
  owner: BridgeSocket | null;
}

// terminal.open calls in flight, one per agent at most. A socket the client
// closes while its open is pending gives the open up instead of leaving it to
// be closed on arrival: the client's next socket for the same agent (a
// reconnect, a Chat → Terminal → Chat → Terminal flick, a re-render) takes it
// over, so a visit costs one consent, one sign-in check and one upgrade. An
// open nobody takes over is closed as soon as it resolves.
export class TerminalOpens {
  private readonly pending = new Map<string, PendingOpen>();
  constructor(private readonly bridge: TerminalBridge, readonly router: TerminalRouter) {}

  get inFlight(): number {
    return this.pending.size;
  }

  request(socket: BridgeSocket, connection: string, agent: string): void {
    const key = JSON.stringify([connection, agent]);
    const existing = this.pending.get(key);
    if (existing && !existing.owner) {
      existing.owner = socket;
      return;
    }
    // A second live socket for the same agent (never from the shared client) gets its own open.
    const entry: PendingOpen = { key, owner: socket };
    if (!existing) this.pending.set(key, entry);
    const release = this.router.opening();
    void this.run(entry, connection, agent, release);
  }

  abandon(socket: BridgeSocket): void {
    for (const entry of this.pending.values()) if (entry.owner === socket) entry.owner = null;
  }

  private async run(entry: PendingOpen, connection: string, agent: string, release: ReturnType<TerminalRouter["opening"]>): Promise<void> {
    let outcome: OpenOutcome;
    try {
      const result = await this.bridge.open(connection, agent);
      if (result?.cancelled === true) outcome = { cancelled: true };
      else if (typeof result?.id === "string") outcome = { id: result.id };
      else outcome = { error: "Terminal unavailable" };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
    const id = "id" in outcome ? outcome.id : undefined;
    const owner = entry.owner;
    if (owner?.settle(outcome) && id) {
      // After onopen (which resets the screen), so held output replays onto it.
      release(owner, id);
      return;
    }
    release(null, id);
    // Nobody took it over, or the client closed it from onopen (then the socket closed it).
    if (id && owner?.closedId !== id) this.bridge.close(id).catch((error: unknown) => this.bridge.warn("terminal.close failed", error));
  }
}
