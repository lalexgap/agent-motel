// Fixture am server: the HTTP API the browser UI uses, over synthetic data
// held in memory, for the desktop dev server, screenshots and tests.
//   bun desktop/fixtures/server.ts [--port 8791]
// Routes live in routes.ts, state in store.ts, the browser sign-in and the
// interactive terminal in terminal.ts. Test hooks, all bearer-gated:
//   GET  /__fixture/requests  every authorised non-GET request, in order, plus every
//                             /auth/* request (never the token), terminal preflight
//                             (GET), upgrade (UPGRADE, status 101 when it opened) and
//                             terminal message or close (WS, per terminal id); the
//                             x-fixture-open-terminals header counts open terminals
//   GET  /__fixture/terminals {open: [{terminal, agent, cols, rows}], sessions}
//   POST /__fixture/reset     back to the seeded state (also clears the log); like a
//                             restart, terminals close with 1001 and sessions are forgotten
//   POST /__fixture/terminal/expire  revokes every session: terminals close with 4001
//   POST /__fixture/terminal/flood   the next terminal to attach sends 8 MiB of output
import type { Server } from "bun";
import type { FixtureRow } from "./data";
import { buildRoutes, json, PASTE_MAX_BYTES, type Ctx, type Route } from "./routes";
import { createState, type FixtureState } from "./store";
import { createTerminalHost, type TerminalData } from "./terminal";

export { ulid } from "./store";
export { FIXTURE_IDS } from "./extras";
export { LOCKED_AGENT, PINNED_BUSY_AGENT } from "./routes";
export { FLOOD_BYTES, FLOOD_LINE_BYTES, floodLine, SESSION_COOKIE, terminalPrompt } from "./terminal";

export const FIXTURE_TOKEN = "fixture-token";
export const DEFAULT_FIXTURE_PORT = 8791;
// Like the real server: a JSON body must declare its length and stay under 256 KiB.
const JSON_MAX_BYTES = 256 * 1024;

export interface FixtureRequest {
  method: string;
  path: string;
  body: unknown;
  // /auth/* and terminal entries: the response status, and the terminal it concerns.
  status?: number;
  terminal?: string;
}

export interface FixtureServer {
  url: string;
  port: number;
  rows: FixtureRow[];
  requests: FixtureRequest[];
  // Terminals still open on the server side.
  openTerminals(): { terminal: string; agent: string; cols: number; rows: number }[];
  reset(): void;
  stop(): void;
}

export interface FixtureOptions {
  port?: number;
  flipMs?: number;
  deliverMs?: number;
  replyMs?: number;
  // Each step of resume/restart/model/move/create/handoff (starting → idle, …).
  transitionMs?: number;
  // Browser session lifetime (the real server's is a fixed 12 h).
  sessionTtlMs?: number;
}

export function startFixtureServer(options: FixtureOptions = {}): FixtureServer {
  const rows: FixtureRow[] = [];
  const requests: FixtureRequest[] = [];
  let state: FixtureState = createState(rows);
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      streams.delete(controller);
    }
  };
  const broadcast = (event: string, data: unknown) => {
    for (const controller of streams) send(controller, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  let origin = "";
  // Built before the routes, which tell it when an agent's session ends.
  let terminalTarget: ReturnType<typeof buildRoutes>["terminalTarget"] = () => json({ error: "not found" }, 404);
  let keyOf: ReturnType<typeof buildRoutes>["keyOf"] = (row) => row.name;
  const terminals = createTerminalHost({
    origin: () => origin,
    token: FIXTURE_TOKEN,
    sessionTtlMs: options.sessionTtlMs,
    log: (entry) => requests.push(entry),
    target: (raw) => terminalTarget(raw),
    keyOf: (row) => keyOf(row),
  });
  const built = buildRoutes({
    state: () => state,
    broadcast,
    later,
    deliverMs: options.deliverMs ?? 1500,
    replyMs: options.replyMs ?? 3000,
    transitionMs: options.transitionMs ?? 500,
    detachTerminals: (row) => terminals.detach(row),
  });
  const { routes, flipDrift } = built;
  terminalTarget = built.terminalTarget;
  keyOf = built.keyOf;
  const table = routes.map((route) => ({ route, parts: route.path.split("/").filter(Boolean) }));
  function match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    for (const { route, parts: pattern } of table) {
      if (route.method !== method || pattern.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (pattern.every((segment, index) => (segment.startsWith(":") ? ((params[segment.slice(1)] = parts[index]!), true) : segment === parts[index]))) {
        return { route, params };
      }
    }
    return null;
  }

  function reset() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    terminals.reset();
    state = createState(rows);
    requests.length = 0;
    broadcast("fleet", { type: "reset", at: new Date().toISOString() });
  }

  function events(req: Request): Response {
    let self: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        streams.add(controller);
        send(controller, `event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      },
      cancel() {
        streams.delete(self);
      },
    });
    req.signal.addEventListener("abort", () => streams.delete(self));
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  const server: Server<TerminalData> = Bun.serve<TerminalData>({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_FIXTURE_PORT,
    idleTimeout: 0,
    maxRequestBodySize: PASTE_MAX_BYTES + 64 * 1024,
    websocket: terminals.websocket,
    async fetch(req, server) {
      const url = new URL(req.url);
      const bearerValid = req.headers.get("authorization") === `Bearer ${FIXTURE_TOKEN}`;
      // Browser sign-in: only the Origin and the token in the body count, never the bearer header.
      if (url.pathname === "/auth/login" || url.pathname === "/auth/logout") {
        const length = req.headers.get("content-length");
        if (length === null ? req.body !== null : Number(length) > JSON_MAX_BYTES) {
          requests.push({ method: req.method, path: url.pathname, body: null, status: 413 });
          return json({ error: "request body too large" }, 413);
        }
        return (await terminals.auth.route(req, url.pathname))!;
      }
      if (/^\/api\/agents\/[^/]+\/terminal$/.test(url.pathname)) return terminals.handle(req, server, url, bearerValid);
      if (!bearerValid) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET" && url.pathname === "/__fixture/requests") {
        const response = json(requests);
        response.headers.set("x-fixture-open-terminals", String(terminals.open().length));
        return response;
      }
      if (req.method === "GET" && url.pathname === "/__fixture/terminals") return json({ open: terminals.open(), sessions: terminals.auth.size });
      if (req.method === "POST" && url.pathname === "/__fixture/terminal/expire") {
        terminals.expire();
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/__fixture/terminal/flood") {
        terminals.floodNext();
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/__fixture/reset") {
        reset();
        return json({ ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/events") return events(req);
      const ctx: Ctx = { req, url, params: {}, body: null };
      if (req.method !== "GET") {
        const path = url.pathname + url.search;
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 4 && parts[0] === "api" && parts[1] === "agents" && parts[3] === "files") {
          ctx.bytes = new Uint8Array(await req.arrayBuffer().catch(() => new ArrayBuffer(0)));
          requests.push({ method: req.method, path, body: { contentType: req.headers.get("content-type"), bytes: ctx.bytes.length } });
        } else {
          const length = req.headers.get("content-length");
          if ((length === null && req.body) || Number(length) > JSON_MAX_BYTES) {
            requests.push({ method: req.method, path, body: null });
            return json({ error: "request body too large" }, 413);
          }
          const raw = await req.text().catch(() => "");
          let logged: unknown = raw === "" ? null : raw;
          try {
            logged = raw === "" ? null : JSON.parse(raw);
            ctx.body = logged;
          } catch {}
          requests.push({ method: req.method, path, body: logged });
        }
      }
      const found = match(req.method, url.pathname);
      if (!found) return json({ error: "not found" }, 404);
      ctx.params = found.params;
      try {
        return await found.route.handler(ctx);
      } catch {
        return json({ error: "request failed" }, 500);
      }
    },
  });

  origin = `http://127.0.0.1:${server.port}`;
  const flip = setInterval(flipDrift, options.flipMs ?? 5000);
  const keepalive = setInterval(() => {
    for (const controller of streams) send(controller, ": keepalive\n\n");
  }, 15000);

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    rows,
    requests,
    openTerminals: () => terminals.open(),
    reset,
    stop() {
      terminals.reset();
      clearInterval(flip);
      clearInterval(keepalive);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const controller of streams) {
        try {
          controller.close();
        } catch {}
      }
      streams.clear();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--port");
  const port = index > 0 ? Number(process.argv[index + 1]) : DEFAULT_FIXTURE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("usage: bun desktop/fixtures/server.ts [--port 8791]");
    process.exit(2);
  }
  const fixture = startFixtureServer({ port });
  console.log(`fixture am server on ${fixture.url} (token: ${FIXTURE_TOKEN})`);
}
