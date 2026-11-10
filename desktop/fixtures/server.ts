// Fixture am server: the read surface the app uses plus the two message
// mutations, over synthetic data held in memory, for the desktop dev server,
// screenshots and tests.
//   bun desktop/fixtures/server.ts [--port 8791]
import { agentId } from "../src/fleet";
import { checkMessageText } from "../src/policy";
import type { AgentRow, QueueItem, TranscriptEntry } from "../src/types";
import { buildDetail, buildRows, buildTranscript, FIXTURE_LOCAL_HOST, FIXTURE_REMOTE_HOSTS, seedQueue } from "./data";

export const FIXTURE_TOKEN = "fixture-token";
export const DEFAULT_FIXTURE_PORT = 8791;
const DRIFTING_AGENT = "drift-net";
// Stays working for the whole run, so a message queued to it can always be cancelled.
const PINNED_BUSY_AGENT = "harbor-lights";
const STOPPED = new Set(["exited", "dead"]);
const REPLY = "Got it. I'll fold that in and report back here when it's done.";

export interface FixtureRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FixtureServer {
  url: string;
  port: number;
  rows: AgentRow[];
  requests: FixtureRequest[];
  stop(): void;
}

interface Message {
  id: string;
  agent: string;
  text: string;
  mode: "queue" | "now";
  state: "queued" | "delivered" | "cancelled";
  queuedAt: string;
  // An inter-agent message: listed with this msgId, which has no record behind it.
  peerMsgId?: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()): string {
  let time = "";
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  let random = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) random += CROCKFORD[byte % 32];
  return time + random;
}

export function startFixtureServer(options: { port?: number; flipMs?: number; deliverMs?: number; replyMs?: number } = {}): FixtureServer {
  const deliverMs = options.deliverMs ?? 1500;
  const replyMs = options.replyMs ?? 3000;
  const rows = buildRows(Date.now());
  const transcripts = new Map(rows.map((row) => [agentId(row), buildTranscript(row)]));
  const messages = new Map<string, Message>();
  const queues = new Map<string, Message[]>();
  // Agents in the middle of a fixture delivery; the drift-net flip leaves them alone.
  const delivering = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests: FixtureRequest[] = [];
  for (const row of rows) {
    const seeded = seedQueue(row, () => ulid());
    if (!seeded.length) continue;
    queues.set(agentId(row), seeded.map((item) => {
      const message: Message = {
        id: ulid(), agent: agentId(row), text: item.message ?? "", mode: "queue", state: "queued", queuedAt: item.queuedAt ?? new Date().toISOString(),
        ...(item.msgId ? { peerMsgId: item.msgId } : {}),
      };
      if (!message.peerMsgId) messages.set(message.id, message);
      return message;
    }));
  }

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

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const queueOf = (id: string) => queues.get(id) ?? [];
  // Like am, only `queue` messages are listed; a `now` message goes straight to the pane.
  const listedOf = (id: string) => queueOf(id).filter((item) => item.mode === "queue");
  const syncQueued = (row: AgentRow) => {
    const count = listedOf(agentId(row)).length;
    if (count) row.queued = count;
    else delete row.queued;
  };
  const setStatus = (row: AgentRow, status: AgentRow["status"]) => {
    const now = new Date().toISOString();
    if (row.status !== status) row.statusChangedAt = now;
    row.status = status;
    row.updatedAt = now;
    if (status === "working") row.workingSince ??= now;
    else delete row.workingSince;
  };
  const appendEntry = (id: string, entry: { kind: "user" | "assistant"; text: string }) => {
    const entries: TranscriptEntry[] = transcripts.get(id) ?? [];
    entries.push({ ...entry, index: (entries.at(-1)?.index ?? -1) + 1 });
    transcripts.set(id, entries);
  };

  // Accepted → (deliverMs) user turn, agent working → (replyMs) canned reply, agent idle.
  function deliver(row: AgentRow, message: Message): void {
    const id = agentId(row);
    delivering.add(id);
    later(deliverMs, () => {
      if (message.state !== "queued") {
        delivering.delete(id);
        drain(row);
        return;
      }
      message.state = "delivered";
      queues.set(id, queueOf(id).filter((item) => item !== message));
      syncQueued(row);
      appendEntry(id, { kind: "user", text: message.text });
      setStatus(row, "working");
      broadcast("fleet", { type: "message", agent: row.name, host: row.host, id: message.id, state: "delivered" });
      later(replyMs, () => {
        appendEntry(id, { kind: "assistant", text: REPLY });
        delivering.delete(id);
        if (row.name !== PINNED_BUSY_AGENT || row.host) setStatus(row, "idle");
        else row.updatedAt = new Date().toISOString();
        broadcast("fleet", { type: "status", agent: row.name, host: row.host, status: row.status, at: row.updatedAt });
        drain(row);
      });
    });
  }

  // One delivery at a time: the oldest `now` message, or the oldest of any once the agent is idle.
  function drain(row: AgentRow): void {
    const id = agentId(row);
    if (delivering.has(id)) return;
    const next = queueOf(id).find((item) => item.state === "queued" && (item.mode === "now" || row.status === "idle"));
    if (next) deliver(row, next);
  }

  function postMessage(row: AgentRow | undefined, key: string, body: unknown): Response {
    const data = body && typeof body === "object" ? (body as { text?: unknown; mode?: unknown }) : {};
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400);
    const checked = checkMessageText(data.text);
    if (!checked.ok) return json({ error: checked.error }, 400);
    if (data.mode !== "queue" && data.mode !== "now") return json({ error: "mode must be queue or now" }, 400);
    if (!row) return json({ error: `no agent "${key}"` }, 404);
    if (STOPPED.has(row.status)) return json({ error: `agent "${key}" has no live tmux session`, reason: "no_session" }, 409);
    const id = agentId(row);
    const message: Message = { id: ulid(), agent: id, text, mode: data.mode, state: "queued", queuedAt: new Date().toISOString() };
    messages.set(message.id, message);
    queues.set(id, [...queueOf(id), message]);
    syncQueued(row);
    row.updatedAt = new Date().toISOString();
    broadcast("fleet", { type: "message", agent: row.name, host: row.host, id: message.id, state: "queued" });
    // `now` steers the current turn; `queue` waits until the agent is free.
    drain(row);
    return json({ ok: true, mode: data.mode, id: message.id });
  }

  function cancelMessage(row: AgentRow | undefined, key: string, rawId: string): Response {
    if (!row) return json({ error: `no agent "${key}"` }, 404);
    const message = messages.get(rawId);
    if (!message || message.agent !== agentId(row)) return json({ error: `no message "${rawId}" for agent "${key}"` }, 404);
    if (message.state === "delivered" || message.mode === "now") return json({ error: "message was already delivered", reason: "already_delivered", state: "delivered" }, 409);
    if (message.state === "cancelled") return json({ error: "message was already cancelled", reason: "already_cancelled", state: "cancelled" }, 409);
    message.state = "cancelled";
    queues.set(message.agent, queueOf(message.agent).filter((item) => item !== message));
    syncQueued(row);
    row.updatedAt = new Date().toISOString();
    broadcast("fleet", { type: "message", agent: row.name, host: row.host, id: message.id, state: "cancelled" });
    return json({ ok: true, state: "cancelled" });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_FIXTURE_PORT,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${FIXTURE_TOKEN}`) return json({ error: "unauthorized" }, 401);
      if (req.method !== "GET") {
        const raw = await req.text().catch(() => "");
        let body: unknown = raw === "" ? null : raw;
        try {
          body = raw === "" ? null : JSON.parse(raw);
        } catch {}
        requests.push({ method: req.method, path: url.pathname + url.search, body });
        return mutate(req.method, url, body);
      }
      if (url.pathname === "/__fixture/requests") return json(requests);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return json({ error: "not found" }, 404);
      const [, resource, rawKey, sub] = parts;
      if (parts.length === 2 && resource === "health") return json({ ok: true, name: "am" });
      if (parts.length === 2 && resource === "hosts") return json({ local: FIXTURE_LOCAL_HOST, hosts: FIXTURE_REMOTE_HOSTS });
      if (parts.length === 2 && resource === "agents") {
        return json({ rows, unreachable: FIXTURE_REMOTE_HOSTS.filter((host) => !host.reachable).map((host) => host.name) });
      }
      if (resource === "agents" && rawKey && (parts.length === 3 || (parts.length === 4 && sub === "transcript"))) {
        const key = decodeKey(rawKey);
        if (key === null) return json({ error: "bad agent key" }, 400);
        const row = rows.find((candidate) => agentId(candidate) === key);
        if (!row) return json({ error: `no agent "${key}"` }, 404);
        // Like am: an API-queued entry carries no msgId; its record id stays internal.
        if (!sub) {
          return json(buildDetail(row, listedOf(key).map((item): QueueItem => ({
            message: item.text, queuedAt: item.queuedAt, ...(item.peerMsgId ? { msgId: item.peerMsgId } : {}),
          }))));
        }
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

  function decodeKey(raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  function mutate(method: string, url: URL, body: unknown): Response {
    const parts = url.pathname.split("/").filter(Boolean);
    const [root, resource, rawKey, sub, rawId] = parts;
    if (root !== "api" || resource !== "agents" || !rawKey || sub !== "messages") return json({ error: "method not allowed" }, 405);
    const key = decodeKey(rawKey);
    if (key === null) return json({ error: "bad agent key" }, 400);
    const row = rows.find((candidate) => agentId(candidate) === key);
    if (parts.length === 4 && method === "POST") return postMessage(row, key, body);
    if (parts.length === 5 && method === "DELETE") return cancelMessage(row, key, decodeKey(rawId!) ?? "");
    return json({ error: "method not allowed" }, 405);
  }

  // drift-net flips between working and idle so live updates are visible.
  const flip = setInterval(() => {
    const row = rows.find((candidate) => candidate.name === DRIFTING_AGENT && !candidate.host);
    if (!row || delivering.has(agentId(row))) return;
    setStatus(row, row.status === "working" ? "idle" : "working");
    broadcast("fleet", { type: "status", agent: row.name, status: row.status, at: row.updatedAt });
    drain(row);
  }, options.flipMs ?? 5000);
  const keepalive = setInterval(() => {
    for (const controller of streams) send(controller, ": keepalive\n\n");
  }, 15000);

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    rows,
    requests,
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
