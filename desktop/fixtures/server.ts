// Fixture am server: the HTTP API the browser UI uses, over synthetic data
// held in memory, for the desktop dev server, screenshots and tests.
//   bun desktop/fixtures/server.ts [--port 8791]
// Routes live in routes.ts, state in store.ts. Test hooks, all bearer-gated:
//   GET  /__fixture/requests  every authorised non-GET request, in order
//   POST /__fixture/reset     back to the seeded state (also clears the log)
import type { FixtureRow } from "./data";
import { buildRoutes, json, PASTE_MAX_BYTES, type Ctx, type Route } from "./routes";
import { createState, type FixtureState } from "./store";

export { ulid } from "./store";
export { FIXTURE_IDS } from "./extras";
export { LOCKED_AGENT, PINNED_BUSY_AGENT } from "./routes";

export const FIXTURE_TOKEN = "fixture-token";
export const DEFAULT_FIXTURE_PORT = 8791;
// Like the real server: a JSON body must declare its length and stay under 256 KiB.
const JSON_MAX_BYTES = 256 * 1024;

export interface FixtureRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FixtureServer {
  url: string;
  port: number;
  rows: FixtureRow[];
  requests: FixtureRequest[];
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

  const { routes, flipDrift } = buildRoutes({
    state: () => state,
    broadcast,
    later,
    deliverMs: options.deliverMs ?? 1500,
    replyMs: options.replyMs ?? 3000,
    transitionMs: options.transitionMs ?? 500,
  });
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

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_FIXTURE_PORT,
    idleTimeout: 0,
    maxRequestBodySize: PASTE_MAX_BYTES + 64 * 1024,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${FIXTURE_TOKEN}`) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET" && url.pathname === "/__fixture/requests") return json(requests);
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

  const flip = setInterval(flipDrift, options.flipMs ?? 5000);
  const keepalive = setInterval(() => {
    for (const controller of streams) send(controller, ": keepalive\n\n");
  }, 15000);

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    rows,
    requests,
    reset,
    stop() {
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
