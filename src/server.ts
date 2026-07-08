import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { apiTokenFile, ensureDirs } from "./paths";
import { loadConfig } from "./config";
import { agentProvider, readAgent, resolveAgent } from "./state";
import { cachedFleetRows } from "./fleet";
import { displayStatus } from "./commands/ls";
import { queueList } from "./queue";
import { capturePane, hasSession } from "./tmux";
import { sendCommand, interruptCommand } from "./commands/send";
import { newCommand } from "./commands/new";
import { stopAgent, destroyAgent } from "./commands/rm";
import { reviveAgent } from "./commands/resume";

// The HTTP layer for phone/remote clients (the iOS app, scripts). Unlike the
// daemon's unix socket this listens on TCP, so it is opt-in (`am serve`) and
// bearer-token gated on every /api route. Deployment is expected to add the
// network gate (tailnet bind / Caddy / mTLS) — see docs/ios-app-exploration.md §4e.

const PANE_LINES = 60;

// --- token -----------------------------------------------------------------

export function loadApiToken(): string | null {
  const fromEnv = process.env.AM_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(apiTokenFile())) return null;
  const fromFile = readFileSync(apiTokenFile(), "utf8").trim();
  return fromFile || null;
}

export function createApiToken(): string {
  ensureDirs();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(apiTokenFile(), token + "\n");
  chmodSync(apiTokenFile(), 0o600);
  return token;
}

export function loadOrCreateApiToken(): string {
  return loadApiToken() ?? createApiToken();
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false; // length leak is acceptable here
  return timingSafeEqual(ba, bb);
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

// --- helpers ---------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return Response.json(body as object, { status });
}

function agentDetail(name: string) {
  const agent = readAgent(name);
  if (!agent) return null;
  return {
    name: agent.name,
    status: displayStatus(agent),
    provider: agentProvider(agent),
    dir: agent.dir,
    task: agent.task ?? null,
    worktreeBranch: agent.worktreeBranch ?? null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    queue: queueList(agent.name),
    pane: hasSession(agent.tmuxSession)
      ? (capturePane(agent.tmuxSession)?.slice(-PANE_LINES).join("\n") ?? null)
      : null,
  };
}

// --- routing ---------------------------------------------------------------

async function handleApi(req: Request, parts: string[]): Promise<Response> {
  const method = req.method;

  // GET /api/health
  if (parts.length === 1 && parts[0] === "health" && method === "GET") {
    return json({ ok: true, name: "am" });
  }

  // GET /api/agents — merged local + remote fleet (cached; never blocks on ssh)
  if (parts.length === 1 && parts[0] === "agents" && method === "GET") {
    const fleet = cachedFleetRows();
    return json({ rows: fleet.rows, unreachable: fleet.unreachable });
  }

  // POST /api/agents — spawn a new (local) agent
  if (parts.length === 1 && parts[0] === "agents" && method === "POST") {
    const body = (await req.json().catch(() => null)) as
      | { name?: string; task?: string; dir?: string; codex?: boolean }
      | null;
    if (!body?.name) return json({ error: "name required" }, 400);
    try {
      await newCommand({
        name: body.name,
        message: body.task,
        dir: body.dir,
        provider: body.codex ? "codex" : undefined,
        jump: false,
        quiet: true,
      });
      return json({ ok: true, name: body.name }, 201);
    } catch (error) {
      return json({ error: (error as Error).message }, 409);
    }
  }

  // /api/agents/:name[/...]
  if (parts[0] === "agents" && parts.length >= 2) {
    const name = decodeURIComponent(parts[1]!);

    // GET /api/agents/:name — detail + queue + pane snapshot (local agents)
    if (parts.length === 2 && method === "GET") {
      const detail = agentDetail(name);
      return detail ? json(detail) : json({ error: `no local agent "${name}"` }, 404);
    }

    // DELETE /api/agents/:name — kill + forget
    if (parts.length === 2 && method === "DELETE") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      destroyAgent(agent, { clean: false });
      return json({ ok: true });
    }

    // POST /api/agents/:name/messages — {text, mode: queue|now|interrupt}
    if (parts.length === 3 && parts[2] === "messages" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { text?: string; mode?: string } | null;
      const text = body?.text?.trim();
      if (!text) return json({ error: "text required" }, 400);
      const mode = body?.mode ?? "queue";
      try {
        if (mode === "interrupt") await interruptCommand(name, text);
        else await sendCommand(name, text, { now: mode === "now" });
        return json({ ok: true, mode });
      } catch (error) {
        return json({ error: (error as Error).message }, 409);
      }
    }

    // POST /api/agents/:name/stop
    if (parts.length === 3 && parts[2] === "stop" && method === "POST") {
      try {
        stopAgent(resolveAgent(name));
        return json({ ok: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 404);
      }
    }

    // POST /api/agents/:name/resume
    if (parts.length === 3 && parts[2] === "resume" && method === "POST") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      try {
        await reviveAgent(agent);
        return json({ ok: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 409);
      }
    }
  }

  return json({ error: "not found" }, 404);
}

export interface ApiServerHandle {
  stop(): void;
  port: number;
  hostname: string;
  url: string;
}

export function startApiServer(opts: { port?: number; hostname?: string; token: string }): ApiServerHandle {
  const { token } = opts;
  const server = Bun.serve({
    port: opts.port ?? loadConfig().apiPort,
    hostname: opts.hostname ?? loadConfig().apiBind,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api" || path.startsWith("/api/")) {
        const supplied = bearer(req) ?? url.searchParams.get("token");
        if (!supplied || !tokensMatch(supplied, token)) {
          return json({ error: "unauthorized" }, 401);
        }
        const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
        return handleApi(req, parts);
      }

      // API only — the PWA shell this used to serve is gone.
      return json({ error: "not found" }, 404);
    },
  });

  const hostname = server.hostname ?? opts.hostname ?? "127.0.0.1";
  const port = server.port ?? 0;
  return {
    stop: () => server.stop(true),
    port,
    hostname,
    url: `http://${hostname}:${port}`,
  };
}
