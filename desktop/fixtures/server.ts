// Fixture am server: the milestone 1 read surface (GET only) over synthetic
// data, for the desktop dev server, screenshots and tests.
//   bun desktop/fixtures/server.ts [--port 8791]
import { agentId } from "../src/fleet";
import type { AgentRow } from "../src/types";
import { buildDetail, buildRows, buildTranscript, FIXTURE_LOCAL_HOST, FIXTURE_REMOTE_HOSTS } from "./data";

export const FIXTURE_TOKEN = "fixture-token";
export const DEFAULT_FIXTURE_PORT = 8791;
const DRIFTING_AGENT = "drift-net";

export interface FixtureServer {
  url: string;
  port: number;
  rows: AgentRow[];
  stop(): void;
}

export function startFixtureServer(options: { port?: number; flipMs?: number } = {}): FixtureServer {
  const rows = buildRows(Date.now());
  const transcripts = new Map(rows.map((row) => [agentId(row), buildTranscript(row)]));
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

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_FIXTURE_PORT,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${FIXTURE_TOKEN}`) return json({ error: "unauthorized" }, 401);
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return json({ error: "not found" }, 404);
      const [, resource, rawKey, sub] = parts;
      if (parts.length === 2 && resource === "health") return json({ ok: true, name: "am" });
      if (parts.length === 2 && resource === "hosts") return json({ local: FIXTURE_LOCAL_HOST, hosts: FIXTURE_REMOTE_HOSTS });
      if (parts.length === 2 && resource === "agents") {
        return json({ rows, unreachable: FIXTURE_REMOTE_HOSTS.filter((host) => !host.reachable).map((host) => host.name) });
      }
      if (resource === "agents" && rawKey && (parts.length === 3 || (parts.length === 4 && sub === "transcript"))) {
        let key: string;
        try {
          key = decodeURIComponent(rawKey);
        } catch {
          return json({ error: "bad agent key" }, 400);
        }
        const row = rows.find((candidate) => agentId(candidate) === key);
        if (!row) return json({ error: `no agent "${key}"` }, 404);
        if (!sub) return json(buildDetail(row));
        const entries = transcripts.get(key) ?? [];
        return json({ provider: row.provider, sessionId: `fixture-${row.name}`, status: row.status, total: entries.length, entries });
      }
      if (parts.length === 2 && resource === "events") {
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
      return json({ error: "not found" }, 404);
    },
  });

  // drift-net flips between working and idle so live updates are visible.
  const flip = setInterval(() => {
    const row = rows.find((candidate) => candidate.name === DRIFTING_AGENT && !candidate.host);
    if (!row) return;
    const now = new Date().toISOString();
    row.status = row.status === "working" ? "idle" : "working";
    row.statusChangedAt = now;
    row.updatedAt = now;
    if (row.status === "working") row.workingSince = now;
    else delete row.workingSince;
    broadcast("fleet", { type: "status", agent: row.name, status: row.status, at: now });
  }, options.flipMs ?? 5000);
  const keepalive = setInterval(() => {
    for (const controller of streams) send(controller, ": keepalive\n\n");
  }, 15000);

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    rows,
    stop() {
      clearInterval(flip);
      clearInterval(keepalive);
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
