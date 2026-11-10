// The dev server's stand-in for the native bridge: same methods, same
// validation, connections held in memory. Tokens never leave this module.
import { externalUrlAllowed, normalizeServerUrl, validateApiPath } from "./src/policy";
import type { BridgeEventName, BridgeEvents, Connection, StreamState } from "./src/types";

interface StoredConnection {
  id: string;
  name: string;
  url: string;
  token: string;
}
type Listener = (name: BridgeEventName, payload: unknown) => void;

const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

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

  // Used by `dev.ts --fixture` to pre-create a connection.
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
        const id = text(params.id, "id");
        this.stopStream(id);
        this.connections.delete(id);
        this.states.delete(id);
        return {};
      }
      case "api.get":
        return this.apiGet(text(params.connection, "connection"), params.path);
      case "events.start":
        this.startStream(this.connection(text(params.connection, "connection")));
        return {};
      case "events.stop":
        this.stopStream(text(params.connection, "connection"));
        return {};
      case "open.external":
        if (!externalUrlAllowed(params.url)) throw new Error("Only http and https links without credentials can be opened");
        // The browser opens the tab itself; the native app hands it to the default browser.
        return {};
      default:
        throw new Error(`unknown method: ${typeof method === "string" ? method : String(method)}`);
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
    const url = normalizeServerUrl(rawUrl);
    if (!url.ok) throw new Error(url.error);
    if (!token.trim()) throw new Error("token is required");
    try {
      const response = await this.fetchImpl(`${url.url}/api/health`, {
        headers: { authorization: `Bearer ${token.trim()}` },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await readJson(response)) as { error?: unknown } | null;
      if (response.status === 200) return { ok: true, status: 200 };
      return { ok: false, status: response.status, ...(typeof body?.error === "string" ? { error: body.error } : {}) };
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private save(params: Record<string, unknown>): Connection {
    const name = text(params.name, "name").trim();
    if (!name || name.length > 100) throw new Error("Name must be 1–100 characters");
    const url = normalizeServerUrl(text(params.url, "url"));
    if (!url.ok) throw new Error(url.error);
    const token = params.token === undefined || params.token === null ? "" : text(params.token, "token").trim();
    if (params.id !== undefined) {
      const existing = this.connection(text(params.id, "id"));
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
    if (!token) throw new Error("A new connection needs an access token");
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
    let buffer = "", event = "", data: string[] = [];
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
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}
