// The dev server's stand-in for the native bridge: same methods, same
// validation, connections held in memory. Tokens never leave this module.
import {
  AGENT_GONE,
  buildAction,
  checkAgent,
  checkMessageId,
  checkMessageText,
  checkMode,
  externalUrlAllowed,
  isActionMethod,
  isConfirmMethod,
  messagesPath,
  normalizeServerUrl,
  precheckFailed,
  precheckStatus,
  validateApiPath,
  type ActionRequest,
  type Checked,
} from "./src/policy";
import type { BridgeEventName, BridgeEvents, Connection, DevConfirmation, StreamState } from "./src/types";

interface StoredConnection {
  id: string;
  name: string;
  url: string;
  token: string;
}
type Listener = (name: BridgeEventName, payload: unknown) => void;

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

  constructor(private readonly info: { version: string; build: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // A page that (re)loads mid-stream still learns each connection's state.
    for (const payload of this.states.values()) listener("events.state", payload);
    return () => this.listeners.delete(listener);
  }

  emit<N extends BridgeEventName>(name: N, payload: BridgeEvents[N]): void {
    if (name === "events.state") {
      const state = payload as BridgeEvents["events.state"];
      if (this.connections.has(state.connection)) this.states.set(state.connection, state);
    }
    for (const listener of this.listeners) listener(name, payload);
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
        this.stopStream(id);
        this.connections.delete(id);
        this.states.delete(id);
        return {};
      }
      case "api.get":
        return this.apiGet(text(params.connection, "connection"), params.path);
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
    const response = await this.fetchImpl(conn.url + request.precheckPath!, {
      method: "GET",
      headers: { authorization: `Bearer ${conn.token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readJson(response);
    if (response.status === 404) throw new Error(AGENT_GONE);
    if (response.status !== 200) throw new Error(precheckFailed(response.status));
    const status = precheckStatus(body);
    const now = Date.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    if (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { connection: conn.id, url: conn.url, request, expires: now + CONFIRM_TICKET_TTL_MS });
    const spec = request.confirm!;
    return { ticket, title: spec.title, body: spec.body(status), button: spec.button, defaultIsCancel: spec.defaultIsCancel, server: conn.name };
  }

  private async redeem(id: unknown, accept: unknown): Promise<unknown> {
    const ticket = typeof id === "string" ? this.tickets.get(id) : undefined;
    if (typeof id === "string") this.tickets.delete(id);
    if (!ticket || ticket.expires <= Date.now()) throw new Error("This confirmation has expired or was already answered");
    if (accept !== true) return { cancelled: true };
    const conn = this.connection(ticket.connection);
    // The pre-check and the user's answer were about the server it was issued for.
    if (conn.url !== ticket.url) throw new Error("The connection changed; try again");
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
