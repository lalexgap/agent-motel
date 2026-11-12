// The dev server's stand-in for the native bridge: same methods, same
// validation, connections held in memory. Tokens never leave this module.
//
// Terminals follow the native shell's flow and limits. The session cookie never leaves
// this process. There is no consent gate here; bridge.ts asks window.confirm instead.
import {
  AGENT_GONE,
  buildAction,
  checkAgent,
  checkDecisionId,
  checkDecisionsAgent,
  checkMessageId,
  checkMessageText,
  checkMode,
  checkTerminalId,
  checkTerminalInput,
  checkTerminalSize,
  externalUrlAllowed,
  decisionsPageUrl,
  isActionMethod,
  isConfirmMethod,
  MAX_TERMINALS,
  messagesPath,
  normalizeServerUrl,
  parseTerminalControl,
  precheckFailed,
  precheckStatus,
  sessionFromSetCookie,
  TERMINAL_CLOSE,
  TERMINAL_NEEDS_HTTPS,
  TERMINAL_NO_SESSION,
  TERMINAL_OUTPUT_EVENT_BYTES,
  TERMINAL_OUTPUT_EVENT_MS,
  TERMINAL_PAGE_CHANGED,
  TERMINAL_PENDING_MAX_BYTES,
  TERMINAL_PING_MS,
  TERMINAL_QUEUED_INPUT_MAX_BYTES,
  TERMINAL_SESSION_COOKIE,
  TERMINAL_SESSION_REJECTED,
  TERMINAL_STEP_TIMEOUT_MS,
  TERMINAL_TOO_MANY,
  TERMINAL_UNKNOWN,
  TERMINAL_UNREACHABLE,
  terminalCloseReason,
  terminalLoginError,
  terminalPreflightOutcome,
  terminalRequests,
  terminalTransportAllowed,
  terminalUpgradeOutcome,
  utf8Length,
  validateApiPath,
  type ActionRequest,
  type Checked,
} from "./src/policy";
import type { BridgeEventName, BridgeEvents, Connection, DevConfirmation, StreamState, TerminalControl, TerminalOpened } from "./src/types";

interface StoredConnection {
  id: string;
  name: string;
  url: string;
  token: string;
}
// The returned promise settles once the event reached the page; undelivered terminal
// output counts against the backlog cap.
type Listener = (name: BridgeEventName, payload: unknown) => void | Promise<unknown>;

interface Session {
  url: string;
  token: string;
  cookie: string;
}

type Held = { bytes: Uint8Array } | { control: TerminalControl } | { close: { code: number; reason: string } };

interface Terminal {
  id: string;
  connection: string;
  // The session it was opened with: a 4001 drops it if it is still the connection's.
  cookie: string;
  socket: WebSocket;
  // What arrived before terminal.open returned the id (null once released).
  held: Held[] | null;
  heldBytes: number;
  // terminal.closed, deferred when the terminal ended while held.
  report?: () => void;
  chunks: Uint8Array[];
  buffered: number;
  undelivered: number;
  timer?: ReturnType<typeof setTimeout>;
  ping?: ReturnType<typeof setInterval>;
  closed: boolean;
}

type Upgrade =
  | { socket: WebSocket; early: MessageEvent[]; closed: () => CloseEvent | null; release: () => void }
  | { status: number };

const REQUEST_TIMEOUT_MS = 15_000;
// A `now` send to an agent on a remote host goes over ssh.
export const MUTATION_TIMEOUT_MS = 60_000;
// How long an unanswered confirmation ticket stays redeemable.
export const CONFIRM_TICKET_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 32;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// SSEParser.maxLineBytes, applied to each line and to an event's accumulated data (in UTF-16 units here).
const MAX_EVENT_SIZE = 8 << 20;
const OVERSIZED_EVENT = "The event stream sent an oversized event";

// Only pages served by this dev server may drive the bridge. Host pins the
// name the browser used (defeats DNS rebinding); Origin, or Sec-Fetch-Site
// when a same-origin GET omits Origin, proves the caller is our own page.
export function bridgeRequestAllowed(headers: Headers, port: number): boolean {
  const host = headers.get("host") ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = headers.get("origin");
  if (origin !== null) return origin === `http://${host}`;
  return headers.get("sec-fetch-site") === "same-origin";
}

interface Ticket {
  connection: string;
  url: string;
  request: ActionRequest;
  expires: number;
}

const publicView = (conn: StoredConnection): Connection => ({ id: conn.id, name: conn.name, url: conn.url, hasToken: conn.token !== "" });

function record(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
  return params as Record<string, unknown>;
}
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
};
const optionalText = (value: unknown, field: string): string | undefined =>
  value === undefined || value === null ? undefined : text(value, field);

function checked<T>(result: Checked<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function validateToken(token: string): void {
  if (!token) throw new Error("Enter the access token");
  if (token.length > 4096) throw new Error("The access token is too long");
  if (![...token].every((char) => char > " " && char < "\x7f")) throw new Error("The access token must be printable ASCII without spaces");
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text().catch(() => "");
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export class DevBridge {
  private connections = new Map<string, StoredConnection>();
  private streams = new Map<string, AbortController>();
  private states = new Map<string, BridgeEvents["events.state"]>();
  private listeners = new Set<Listener>();
  private tickets = new Map<string, Ticket>();
  private terminals = new Map<string, Terminal>();
  private opening = 0;
  private sessions = new Map<string, Session>();
  private logins = new Map<string, Promise<string>>();
  // Bumped whenever the page's terminals are all closed (it reloaded); an open in progress then fails.
  private page = 0;

  constructor(private readonly info: { version: string; build: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // A page that (re)loads mid-stream still learns each connection's state.
    for (const payload of this.states.values()) listener("events.state", payload);
    return () => this.listeners.delete(listener);
  }

  emit<N extends BridgeEventName>(name: N, payload: BridgeEvents[N]): Promise<unknown>[] {
    if (name === "events.state") {
      const state = payload as BridgeEvents["events.state"];
      if (this.connections.has(state.connection)) this.states.set(state.connection, state);
    }
    const pending: Promise<unknown>[] = [];
    for (const listener of this.listeners) {
      const result = listener(name, payload);
      if (result instanceof Promise) pending.push(result);
    }
    return pending;
  }

  addConnection(name: string, url: string, token: string): Connection {
    const normalized = normalizeServerUrl(url);
    if (!normalized.ok) throw new Error(normalized.error);
    const conn = { id: crypto.randomUUID(), name, url: normalized.url, token };
    this.connections.set(conn.id, conn);
    return publicView(conn);
  }

  async handle(method: unknown, rawParams: unknown): Promise<unknown> {
    const params = record(rawParams);
    switch (method) {
      case "app.info":
        return { version: this.info.version, build: this.info.build, platform: "macos" };
      case "connections.list":
        return [...this.connections.values()].map(publicView);
      case "connections.test":
        return this.test(text(params.url, "url"), text(params.token, "token"));
      case "connections.save":
        return this.save(params);
      case "connections.remove": {
        const id = this.connection(text(params.id, "id")).id;
        this.connectionChanged(id, true);
        this.stopStream(id);
        this.connections.delete(id);
        this.states.delete(id);
        return {};
      }
      case "api.get":
        return this.apiGet(text(params.connection, "connection"), params.path);
      case "decisions.open":
        return this.openDecisions(params);
      case "messages.send": {
        const conn = this.connection(text(params.connection, "connection"));
        const agent = checked(checkAgent(params.agent));
        const body = { text: checked(checkMessageText(params.text)), mode: checked(checkMode(params.mode)) };
        return this.mutate(conn, "POST", messagesPath(agent), JSON.stringify(body));
      }
      case "messages.cancel": {
        const conn = this.connection(text(params.connection, "connection"));
        const agent = checked(checkAgent(params.agent));
        return this.mutate(conn, "DELETE", messagesPath(agent, checked(checkMessageId(params.id))));
      }
      case "events.start": {
        const conn = this.connection(text(params.connection, "connection"));
        const current = this.streams.has(conn.id) ? this.states.get(conn.id) : undefined;
        if (current) this.emit("events.state", current);
        else this.startStream(conn);
        return {};
      }
      case "events.stop":
        this.stopStream(text(params.connection, "connection"));
        return {};
      case "dev.confirm":
        return this.redeem(params.ticket, params.accept);
      case "terminal.open":
        return this.openTerminal(params);
      // Browser dev mode's stand-in for the native consent sheet runs between this check and terminal.open.
      case "dev.terminalCheck": {
        const conn = this.terminalChecks(params);
        return { name: conn.name, url: conn.url };
      }
      case "terminal.input": {
        const terminal = this.liveTerminal(params.id);
        this.sendFrame(terminal, JSON.stringify({ type: "input", data: checked(checkTerminalInput(params.data)) }));
        return {};
      }
      case "terminal.resize": {
        const terminal = this.liveTerminal(params.id);
        this.sendFrame(terminal, JSON.stringify({ type: "resize", ...checked(checkTerminalSize(params.cols, params.rows)) }));
        return {};
      }
      case "terminal.close": {
        const terminal = checkTerminalId(params.id) ? this.terminals.get(params.id) : undefined;
        if (terminal) this.closeTerminal(terminal, TERMINAL_CLOSE.closed);
        return {};
      }
      case "open.external":
        if (!externalUrlAllowed(params.url)) throw new Error("Only http and https links without credentials can be opened");
        // The browser opens the tab itself; the native app hands it to the default browser.
        return {};
      default: {
        if (!isActionMethod(method)) throw new Error(`unknown method: ${typeof method === "string" ? method : String(method)}`);
        const conn = this.connection(text(params.connection, "connection"));
        const request = checked(buildAction(method, params));
        if (!isConfirmMethod(method)) return this.send(conn, request);
        return { confirm: await this.prepareConfirmation(conn, request) };
      }
    }
  }

  stopAll(): void {
    for (const id of [...this.streams.keys()]) this.stopStream(id);
    this.closeAllTerminals();
  }

  // The page went away: its terminals close without events and an open in progress fails.
  closeAllTerminals(): void {
    this.page++;
    for (const terminal of [...this.terminals.values()]) this.closeTerminal(terminal, TERMINAL_CLOSE.closed, false);
  }

  get openTerminalCount(): number {
    return this.terminals.size;
  }

  private connection(id: string): StoredConnection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection: ${id}`);
    return conn;
  }

  private async test(rawUrl: string, token: string): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const url = normalizeServerUrl(rawUrl);
      if (!url.ok) throw new Error(url.error);
      validateToken(token);
      const response = await this.fetchImpl(`${url.url}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await readJson(response)) as { ok?: unknown } | null;
      const status = response.status;
      if (status >= 200 && status < 300) {
        return body?.ok === true ? { ok: true, status } : { ok: false, status, error: "This server did not answer like Agent Motel" };
      }
      if (status === 401 || status === 403) return { ok: false, status, error: "The server rejected the token" };
      if (status >= 300 && status < 400) return { ok: false, status, error: "The server redirected; use the address it redirects to" };
      return { ok: false, status, error: `The server returned HTTP ${status}` };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private save(params: Record<string, unknown>): Connection {
    const id = optionalText(params.id, "id");
    const name = text(params.name, "name").trim();
    if (!name || [...name].length > 200) throw new Error("The name must be 1 to 200 characters");
    const url = normalizeServerUrl(text(params.url, "url"));
    if (!url.ok) throw new Error(url.error);
    const token = optionalText(params.token, "token") ?? "";
    if (token) validateToken(token);
    if (id !== undefined) {
      const existing = this.connection(id);
      // Keeping a token while changing the server would send it to a different origin.
      if (existing.url !== url.url && !token) throw new Error("Enter the token again when changing the server URL");
      const changed = existing.url !== url.url || token !== "";
      if (changed) this.connectionChanged(existing.id, existing.url !== url.url);
      existing.name = name;
      existing.url = url.url;
      if (token) existing.token = token;
      if (changed && this.streams.has(existing.id)) {
        this.stopStream(existing.id);
        this.startStream(existing);
      }
      return publicView(existing);
    }
    if (!token) throw new Error("Enter the access token");
    const conn = { id: crypto.randomUUID(), name, url: url.url, token };
    this.connections.set(conn.id, conn);
    return publicView(conn);
  }

  private async apiGet(id: string, path: unknown): Promise<{ status: number; body: unknown }> {
    const conn = this.connection(id);
    const problem = validateApiPath(path);
    if (problem) throw new Error(problem);
    const response = await this.fetchImpl(conn.url + (path as string), {
      method: "GET",
      headers: { authorization: `Bearer ${conn.token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await readJson(response) };
  }

  private async openDecisions(params: Record<string, unknown>): Promise<Record<string, never>> {
    const conn = this.connection(text(params.connection, "connection"));
    const agent = checked(checkDecisionsAgent(params.agent));
    const decisionId = checked(checkDecisionId(params.decisionId));
    let response: Response;
    try {
      response = await this.fetchImpl(conn.url + "/api/decisions/link", {
        method: "POST",
        headers: { authorization: `Bearer ${conn.token}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ agent }),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Could not reach the server to open the decisions page");
    }
    const body = await readJson(response);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.status === 404 ? "The decisions page is not set up on this server" : `Could not open the decisions page (HTTP ${response.status})`);
    }
    checked(decisionsPageUrl(body, agent, decisionId));
    // Native hands the validated URL to NSWorkspace. Browser dev mode deliberately performs no external open.
    return {};
  }

  // Never retried: after a network failure the server may or may not have acted.
  private async mutate(conn: StoredConnection, method: "POST" | "DELETE", path: string, body?: string): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImpl(conn.url + path, {
      method,
      headers: {
        authorization: `Bearer ${conn.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
    });
    return { status: response.status, body: await readJson(response) };
  }

  // The dev server cannot raise a native alert, so a confirmed action is split
  // in two: this pre-check returns the text and a one-time ticket bound to the
  // already-validated request, and only `dev.confirm` with that ticket sends it.
  // bridge.ts asks window.confirm in between.
  private async prepareConfirmation(conn: StoredConnection, request: ActionRequest): Promise<DevConfirmation> {
    const status = precheckStatus(await this.precheck(conn, request));
    const now = Date.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    if (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { connection: conn.id, url: conn.url, request, expires: now + CONFIRM_TICKET_TTL_MS });
    const spec = request.confirm!;
    return { ticket, title: spec.title, body: spec.body(status), button: spec.button, defaultIsCancel: spec.defaultIsCancel, server: conn.name, url: conn.url };
  }

  // The exact-name detail lookup, before the confirmation and again before sending.
  private async precheck(conn: StoredConnection, request: ActionRequest): Promise<unknown> {
    const response = await this.fetchImpl(conn.url + request.precheckPath!, {
      method: "GET",
      headers: { authorization: `Bearer ${conn.token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readJson(response);
    if (response.status === 404) throw new Error(AGENT_GONE);
    if (response.status !== 200) throw new Error(precheckFailed(response.status));
    return body;
  }

  private async redeem(id: unknown, accept: unknown): Promise<unknown> {
    const ticket = typeof id === "string" ? this.tickets.get(id) : undefined;
    if (typeof id === "string") this.tickets.delete(id);
    if (!ticket || ticket.expires <= Date.now()) throw new Error("This confirmation has expired or was already answered");
    if (accept !== true) return { cancelled: true };
    const conn = this.connection(ticket.connection);
    // The pre-check and the user's answer were about the server it was issued for.
    if (conn.url !== ticket.url) throw new Error("The connection changed; try again");
    // The agent may have gone while the user was answering; its name could then resolve to another one.
    await this.precheck(conn, ticket.request);
    return this.send(conn, ticket.request);
  }

  // Never retried: after a network failure or timeout the server may or may not have acted.
  private async send(conn: StoredConnection, request: ActionRequest): Promise<{ status: number; body: unknown }> {
    const body = request.body === undefined ? undefined : request.body instanceof Uint8Array ? request.body : JSON.stringify(request.body);
    const response = await this.fetchImpl(conn.url + request.path, {
      method: request.method,
      headers: {
        authorization: `Bearer ${conn.token}`,
        accept: "application/json",
        ...(request.contentType === undefined ? {} : { "content-type": request.contentType }),
      },
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return { status: response.status, body: await readJson(response) };
  }

  private liveTerminal(id: unknown): Terminal {
    const terminal = checkTerminalId(id) ? this.terminals.get(id) : undefined;
    if (!terminal || terminal.closed) throw new Error(TERMINAL_UNKNOWN);
    return terminal;
  }

  // Never merged, reordered or retried.
  private sendFrame(terminal: Terminal, frame: string): void {
    if (terminal.socket.readyState !== WebSocket.OPEN) {
      this.closeTerminal(terminal, TERMINAL_CLOSE.lost);
      throw new Error(TERMINAL_UNKNOWN);
    }
    if (terminal.socket.bufferedAmount + utf8Length(frame) > TERMINAL_QUEUED_INPUT_MAX_BYTES) {
      this.closeTerminal(terminal, TERMINAL_CLOSE.inputOverflow);
      throw new Error(TERMINAL_CLOSE.inputOverflow.reason);
    }
    try {
      terminal.socket.send(frame);
    } catch {
      this.closeTerminal(terminal, TERMINAL_CLOSE.lost);
      throw new Error(TERMINAL_UNKNOWN);
    }
  }

  // A removed or re-pointed connection loses its session and its terminals; a new token
  // only the session (the terminals keep the session they were opened with).
  private connectionChanged(connection: string, closeTerminals: boolean): void {
    this.sessions.delete(connection);
    this.logins.delete(connection);
    if (!closeTerminals) return;
    for (const terminal of [...this.terminals.values()]) if (terminal.connection === connection) this.closeTerminal(terminal, TERMINAL_CLOSE.removed);
  }

  private stillWanted(conn: StoredConnection, bound: { url: string; page: number }): void {
    if (this.page !== bound.page) throw new Error(TERMINAL_PAGE_CHANGED);
    if (this.connections.get(conn.id) !== conn || conn.url !== bound.url) throw new Error(`unknown connection: ${conn.id}`);
  }

  // Runs before the consent question.
  private terminalChecks(params: Record<string, unknown>): StoredConnection {
    const conn = this.connection(text(params.connection, "connection"));
    checked(checkAgent(params.agent));
    if (!terminalTransportAllowed(conn.url)) throw new Error(TERMINAL_NEEDS_HTTPS);
    if (this.terminals.size + this.opening >= MAX_TERMINALS) throw new Error(TERMINAL_TOO_MANY);
    return conn;
  }

  private async openTerminal(params: Record<string, unknown>): Promise<TerminalOpened> {
    const conn = this.terminalChecks(params);
    const agent = params.agent as string;
    const bound = { url: conn.url, page: this.page };
    const requests = terminalRequests(conn.url, agent);
    this.opening++;
    try {
      let cookie = await this.session(conn);
      this.stillWanted(conn, bound);
      const signInAgain = async (): Promise<void> => {
        if (this.sessions.get(conn.id)?.cookie === cookie) this.sessions.delete(conn.id);
        cookie = await this.session(conn);
        this.stillWanted(conn, bound);
      };

      let preflight = terminalPreflightOutcome(...(await this.preflight(requests, cookie)));
      if (!preflight.ok && "unauthorized" in preflight) {
        await signInAgain();
        preflight = terminalPreflightOutcome(...(await this.preflight(requests, cookie)));
      }
      if (!preflight.ok) throw new Error("unauthorized" in preflight ? TERMINAL_SESSION_REJECTED : preflight.error);
      this.stillWanted(conn, bound);

      let upgrade = await this.upgrade(requests, cookie);
      if ("status" in upgrade && upgrade.status === 401) {
        await signInAgain();
        upgrade = await this.upgrade(requests, cookie);
      }
      if ("status" in upgrade) {
        const refused = terminalUpgradeOutcome(upgrade.status);
        throw new Error("unauthorized" in refused ? TERMINAL_SESSION_REJECTED : refused.error);
      }
      try {
        this.stillWanted(conn, bound);
        if (upgrade.closed()) throw new Error(TERMINAL_UNREACHABLE);
      } catch (error) {
        upgrade.release();
        upgrade.socket.close(TERMINAL_CLOSE.closed.code);
        throw error;
      }
      return { id: this.register(conn.id, cookie, upgrade), transport: preflight.transport };
    } finally {
      this.opening--;
    }
  }

  // Concurrent opens share one sign-in.
  private async session(conn: StoredConnection): Promise<string> {
    const current = this.sessions.get(conn.id);
    if (current && current.url === conn.url && current.token === conn.token) return current.cookie;
    let pending = this.logins.get(conn.id);
    if (!pending) {
      pending = this.signIn(conn).finally(() => {
        if (this.logins.get(conn.id) === pending) this.logins.delete(conn.id);
      });
      this.logins.set(conn.id, pending);
    }
    return pending;
  }

  // No cookie is sent: signing in with one would revoke the session other terminals still use.
  private async signIn(conn: StoredConnection): Promise<string> {
    const bound = { url: conn.url, token: conn.token };
    let response: Response;
    try {
      response = await this.fetchImpl(`${bound.url}/auth/login`, {
        method: "POST",
        headers: { origin: bound.url, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: bound.token }),
        redirect: "manual",
        signal: AbortSignal.timeout(TERMINAL_STEP_TIMEOUT_MS),
      });
      await response.arrayBuffer();
    } catch {
      throw new Error(TERMINAL_UNREACHABLE);
    }
    const refused = terminalLoginError(response.status);
    if (refused) throw new Error(refused);
    const cookie = sessionFromSetCookie(response.headers.getSetCookie().join(", ") || null);
    if (!cookie) throw new Error(TERMINAL_NO_SESSION);
    if (this.connections.get(conn.id) === conn && conn.url === bound.url && conn.token === bound.token) this.sessions.set(conn.id, { ...bound, cookie });
    return cookie;
  }

  private async preflight(requests: ReturnType<typeof terminalRequests>, cookie: string): Promise<[number, unknown]> {
    try {
      const response = await this.fetchImpl(requests.terminal, {
        method: "GET",
        headers: { origin: requests.origin, cookie: `${TERMINAL_SESSION_COOKIE}=${cookie}`, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(TERMINAL_STEP_TIMEOUT_MS),
      });
      return [response.status, await readJson(response)];
    } catch {
      throw new Error(TERMINAL_UNREACHABLE);
    }
  }

  // Bun's WebSocket reports a refused upgrade only in its error text ("Expected 101 status code: 401").
  private upgrade(requests: ReturnType<typeof terminalRequests>, cookie: string): Promise<Upgrade> {
    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(requests.socket, {
          headers: { origin: requests.origin, cookie: `${TERMINAL_SESSION_COOKIE}=${cookie}` },
        } as unknown as string[]);
      } catch {
        resolve({ status: 0 });
        return;
      }
      socket.binaryType = "arraybuffer";
      const early: MessageEvent[] = [];
      let closed: CloseEvent | null = null;
      let status = 0;
      let settled = false;
      const settle = (result: Upgrade) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        settle({ status: 0 });
        socket.close();
      }, TERMINAL_STEP_TIMEOUT_MS);
      socket.onmessage = (event) => early.push(event);
      socket.onerror = (event) => {
        const match = /Expected 101 status code: (\d{3})/.exec(String((event as ErrorEvent).message ?? ""));
        if (match) status = Number(match[1]);
      };
      socket.onclose = (event) => {
        closed = event;
        settle({ status });
      };
      socket.onopen = () =>
        settle({
          socket,
          early,
          closed: () => closed,
          release: () => {
            socket.onmessage = socket.onclose = socket.onerror = null;
          },
        });
    });
  }

  private register(connection: string, cookie: string, upgrade: Extract<Upgrade, { socket: WebSocket }>): string {
    let id: string;
    do id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    while (this.terminals.has(id));
    const terminal: Terminal = { id, connection, cookie, socket: upgrade.socket, held: [], heldBytes: 0, chunks: [], buffered: 0, undelivered: 0, closed: false };
    this.terminals.set(id, terminal);
    const { socket, early } = upgrade;
    upgrade.release();
    socket.onmessage = (event) => this.received(terminal, event.data);
    socket.onclose = (event) => this.serverClosed(terminal, event.code, event.reason);
    socket.onerror = () => {};
    terminal.ping = setInterval(() => {
      try {
        (socket as unknown as { ping(): void }).ping();
      } catch {}
    }, TERMINAL_PING_MS);
    for (const event of early) this.received(terminal, event.data);
    // Its events wait until terminal.open has returned the id, so the page knows it first.
    setTimeout(() => this.release(terminal), 0);
    return id;
  }

  private received(terminal: Terminal, data: unknown): void {
    if (terminal.closed) return;
    if (typeof data === "string") {
      const control = parseTerminalControl(data);
      if (!control) return;
      if (terminal.held) terminal.held.push({ control });
      else {
        this.flushOutput(terminal);
        this.emit("terminal.control", { id: terminal.id, message: control });
      }
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!bytes?.byteLength) return;
    if (!terminal.held) return this.buffer(terminal, bytes);
    terminal.held.push({ bytes });
    terminal.heldBytes += bytes.byteLength;
    if (terminal.heldBytes > TERMINAL_PENDING_MAX_BYTES) this.closeTerminal(terminal, TERMINAL_CLOSE.outputOverflow);
  }

  private release(terminal: Terminal): void {
    const items = terminal.held ?? [];
    terminal.held = null;
    terminal.heldBytes = 0;
    for (const item of items) {
      if (terminal.closed) break;
      if ("bytes" in item) this.buffer(terminal, item.bytes);
      else if ("control" in item) {
        this.flushOutput(terminal);
        this.emit("terminal.control", { id: terminal.id, message: item.control });
      } else this.end(terminal, item.close);
    }
    if (terminal.closed && terminal.report) {
      const report = terminal.report;
      terminal.report = undefined;
      report();
    }
  }

  private buffer(terminal: Terminal, bytes: Uint8Array): void {
    terminal.chunks.push(bytes);
    terminal.buffered += bytes.byteLength;
    if (terminal.buffered + terminal.undelivered > TERMINAL_PENDING_MAX_BYTES) {
      this.closeTerminal(terminal, TERMINAL_CLOSE.outputOverflow);
      return;
    }
    if (terminal.buffered >= TERMINAL_OUTPUT_EVENT_BYTES) this.flushOutput(terminal);
    else terminal.timer ??= setTimeout(() => this.flushOutput(terminal), TERMINAL_OUTPUT_EVENT_MS);
  }

  private flushOutput(terminal: Terminal): void {
    clearTimeout(terminal.timer);
    terminal.timer = undefined;
    while (terminal.buffered > 0 && !terminal.closed) {
      const size = Math.min(terminal.buffered, TERMINAL_OUTPUT_EVENT_BYTES);
      const event = new Uint8Array(size);
      for (let offset = 0; offset < size; ) {
        const chunk = terminal.chunks[0]!;
        const take = Math.min(chunk.byteLength, size - offset);
        event.set(chunk.subarray(0, take), offset);
        offset += take;
        if (take === chunk.byteLength) terminal.chunks.shift();
        else terminal.chunks[0] = chunk.subarray(take);
      }
      terminal.buffered -= size;
      const pending = this.emit("terminal.output", { id: terminal.id, data: Buffer.from(event).toString("base64") });
      if (pending.length) {
        terminal.undelivered += size;
        void Promise.allSettled(pending).then(() => {
          terminal.undelivered -= size;
        });
      }
    }
  }

  // Bun reports a failed connection as 1006 without a close frame.
  private serverClosed(terminal: Terminal, code: number, reason: string): void {
    if (terminal.closed) return;
    const close = code === 0 || code === TERMINAL_CLOSE.lost.code ? TERMINAL_CLOSE.lost : { code, reason: terminalCloseReason(reason) };
    if (terminal.held) {
      terminal.held.push({ close });
      return;
    }
    this.flushOutput(terminal);
    this.end(terminal, close);
  }

  // Received output still goes first, except after an overflow or when the page is gone.
  private closeTerminal(terminal: Terminal, close: { code: number; reason: string }, notify = true): void {
    if (terminal.closed) return;
    try {
      terminal.socket.close(TERMINAL_CLOSE.closed.code);
    } catch {}
    if (notify && close.code !== TERMINAL_CLOSE.outputOverflow.code && !terminal.held) this.flushOutput(terminal);
    this.end(terminal, close, notify);
  }

  private end(terminal: Terminal, close: { code: number; reason: string }, notify = true): void {
    if (terminal.closed) return;
    terminal.closed = true;
    // The server revoked or expired the session: the next open signs in afresh.
    if (close.code === 4001 && this.sessions.get(terminal.connection)?.cookie === terminal.cookie) this.sessions.delete(terminal.connection);
    clearTimeout(terminal.timer);
    clearInterval(terminal.ping);
    terminal.chunks = [];
    terminal.buffered = 0;
    this.terminals.delete(terminal.id);
    terminal.socket.onmessage = terminal.socket.onclose = null;
    if (!notify) {
      terminal.held = null;
      return;
    }
    const report = () => void this.emit("terminal.closed", { id: terminal.id, code: close.code, reason: close.reason });
    if (terminal.held) terminal.report = report;
    else report();
  }

  private setState(connection: string, state: StreamState, error?: string): void {
    this.emit("events.state", { connection, state, ...(error ? { error } : {}) });
  }

  private startStream(conn: StoredConnection): void {
    if (this.streams.has(conn.id)) return;
    const controller = new AbortController();
    this.streams.set(conn.id, controller);
    void this.runStream(conn, controller.signal);
  }

  private stopStream(id: string): void {
    const controller = this.streams.get(id);
    if (!controller) return;
    controller.abort();
    this.streams.delete(id);
    if (this.connections.has(id)) this.setState(id, "closed");
  }

  private async runStream(conn: StoredConnection, signal: AbortSignal): Promise<void> {
    let delay = BACKOFF_MIN_MS;
    while (!signal.aborted) {
      this.setState(conn.id, "connecting");
      let error = "stream ended";
      try {
        const response = await this.fetchImpl(`${conn.url}/api/events`, {
          headers: { authorization: `Bearer ${conn.token}`, accept: "text/event-stream" },
          redirect: "manual",
          signal,
        });
        if (response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
        this.setState(conn.id, "open");
        delay = BACKOFF_MIN_MS;
        await this.readEvents(conn.id, response.body, signal);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      if (signal.aborted) return;
      this.setState(conn.id, "closed", error);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  private async readEvents(connection: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", event = "", data: string[] = [], dataSize = 0;
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + (buffer[newline] === "\r" ? 2 : 1));
          if (line === "") {
            if (data.length || event) {
              const raw = data.join("\n");
              let parsed: unknown = raw;
              try {
                parsed = JSON.parse(raw);
              } catch {}
              this.emit("events.message", { connection, event: event || "message", data: parsed });
            }
            event = "";
            data = [];
            dataSize = 0;
          } else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            const value = line.slice(5).replace(/^ /, "");
            dataSize += value.length + 1;
            if (dataSize > MAX_EVENT_SIZE) throw new Error(OVERSIZED_EVENT);
            data.push(value);
          }
        }
        if (buffer.length >= MAX_EVENT_SIZE) throw new Error(OVERSIZED_EVENT);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
