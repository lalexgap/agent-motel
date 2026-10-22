import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { apiTokenFile, ensureDirs } from "./paths";
import { type Provider, agentProvider, readAgent, resolveAgent } from "./state";
import { cachedFleetRows } from "./fleet";
import { displayStatus, waitingInfo } from "./commands/ls";
import { buildFleetSummary } from "./summary";
import { queueList } from "./queue";
import { capturePane, hasSession } from "./tmux";
import { sendCommand, interruptCommand, abortTurn } from "./commands/send";
import { transcriptJson } from "./commands/transcript";
import { newCommand } from "./commands/new";
import { stopAgent, destroyAgent } from "./commands/rm";
import { reviveAgent } from "./commands/resume";
import { renameAgent } from "./commands/rename";
import { daemonRequest } from "./daemon";
import { listRoles, roleForAgent } from "./roles";
import { loadConfig, localHostIdentity } from "./config";
import {
  AGENT_NAME_RE,
  HOST_RE,
  REMOTE_NEW_TIMEOUT_MS,
  RemoteError,
  ensureExactCapable,
  remoteSpawnDir,
  resolveHost,
  runRemoteAm,
  runRemoteJson,
} from "./remoteAgents";

// The HTTP layer for remote clients — scripts, and the in-progress native
// phone app (lives on its own branch; nothing on main consumes these routes).
// Unlike the daemon's unix socket this listens on TCP, so it is opt-in
// (`am serve`) and bearer-token gated (Authorization header only) on every
// /api route. Deployment is expected to add the network gate (tailnet bind /
// Caddy / mTLS) — see docs/ios-app-exploration.md §4e.

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

// Self-destruct for service workers installed by the removed PWA: clear its
// caches, unregister, and reload any open clients onto the tombstone page.
const SW_TOMBSTONE = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
})()));
`;

const PWA_GONE_HTML = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<title>am</title><body style="font-family: system-ui; margin: 2rem">
<p>The am web app was removed — this server now exposes only the token-gated API.
You can uninstall this icon.</p>
<script>navigator.serviceWorker?.register("/sw.js");</script>
`;

export function agentDetail(name: string) {
  const agent = readAgent(name);
  if (!agent) return null;
  const status = displayStatus(agent);
  return {
    name: agent.name,
    status,
    statusReason: status === "waiting"
      ? waitingInfo(agent).detail ?? null
      : status === "dead"
        ? "tmux session is missing"
        : agent.statusReason ?? null,
    statusChangedAt: agent.statusChangedAt ?? agent.updatedAt,
    provider: agentProvider(agent),
    role: roleForAgent(agent) ?? null,
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

// --- remote agents ---------------------------------------------------------

// `:name` is a bare local name or `host:name` (the `am send host:name` form).
// Validated here so nothing unchecked reaches ssh or a state-file path.
function parseTarget(raw: string): { host: string | null; name: string } | Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return json({ error: "malformed agent name" }, 400);
  }
  const colon = decoded.indexOf(":");
  const host = colon === -1 ? null : decoded.slice(0, colon);
  const name = colon === -1 ? decoded : decoded.slice(colon + 1);
  if (!AGENT_NAME_RE.test(name)) return json({ error: `invalid agent name "${name}"` }, 400);
  if (host === null) return { host: null, name };
  if (!HOST_RE.test(host)) return json({ error: `invalid host "${host}"` }, 400);
  const resolved = resolveHost(host);
  if (resolved === undefined) return json({ error: `unknown host "${host}" (not in config.remotes)` }, 404);
  return { host: resolved, name };
}

function remoteFailure(error: unknown): Response {
  if (error instanceof RemoteError) return json({ error: error.message }, error.status);
  return json({ error: (error as Error).message }, 502);
}

interface TranscriptShape {
  entries: { index: number }[];
}

async function handleRemoteAgent(req: Request, host: string, name: string, rest: string[]): Promise<Response> {
  const method = req.method;
  const route = rest[0];
  if (rest.length > 1) return json({ error: "not found" }, 404);
  try {
    if (!route && method === "GET") return json(await runRemoteJson(host, ["__detail", name]));
    if (route === "rename" && method === "POST") {
      return json({ error: "rename is not supported for remote agents" }, 501);
    }
    const run = async (args: string[], opts?: { stdin?: string }) => {
      await ensureExactCapable(host, name);
      return runRemoteAm(host, args, opts);
    };

    if (!route && method === "DELETE") {
      await run(["rm", name]);
      return json({ ok: true });
    }

    if (route === "messages" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { text?: unknown; mode?: string } | null;
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "text required" }, 400);
      const mode = body?.mode ?? "queue";
      if (mode === "interrupt") await run(["interrupt", name, "-"], { stdin: text });
      else await run(["send", name, "-", ...(mode === "now" ? ["--now"] : [])], { stdin: text });
      return json({ ok: true, mode });
    }

    if (route === "transcript" && method === "GET") {
      const raw = new URL(req.url).searchParams.get("after");
      const after = raw === null || raw === "" ? 0 : Number(raw);
      if (!Number.isInteger(after) || after < 0) return json({ error: "after must be a non-negative integer" }, 400);
      await ensureExactCapable(host, name);
      const transcript = await runRemoteJson<TranscriptShape>(host, ["transcript", name, "--json"], { timeoutMs: 30_000 });
      if (!Array.isArray(transcript?.entries)) {
        return json({ error: `remote am too old on ${host} (transcript --json has no entries)` }, 409);
      }
      return json({ ...transcript, entries: transcript.entries.filter((entry) => entry.index >= after) });
    }

    if (route === "interrupt" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      if (body?.text != null && typeof body.text !== "string") return json({ error: "text must be a string" }, 400);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text) await run(["interrupt", name, "-"], { stdin: text });
      else await run(["interrupt", name]);
      return json({ ok: true });
    }

    if (route === "stop" && method === "POST") {
      await run(["stop", name]);
      return json({ ok: true });
    }

    if (route === "resume" && method === "POST") {
      await run(["resume", name]);
      return json({ ok: true });
    }
  } catch (error) {
    return remoteFailure(error);
  }
  return json({ error: "not found" }, 404);
}

interface SpawnBody {
  name?: string;
  task?: string;
  dir?: string;
  remoteDir?: string;
  host?: string;
  provider?: string;
  codex?: boolean;
  role?: string;
  model?: string;
  effort?: string;
  inPlace?: boolean;
}

async function spawnRemote(host: string, body: SpawnBody & { name: string }): Promise<Response> {
  if (!AGENT_NAME_RE.test(body.name)) {
    return json({ error: "agent name must be alphanumeric with dashes/underscores" }, 409);
  }
  if (body.remoteDir != null && (typeof body.remoteDir !== "string" || !body.remoteDir.startsWith("/"))) {
    return json({ error: "remoteDir must be an absolute path" }, 400);
  }
  if (body.dir != null && (typeof body.dir !== "string" || !body.dir.startsWith("/"))) {
    return json({ error: "dir must be an absolute path" }, 400);
  }
  const provider = body.provider ?? (body.codex ? "codex" : undefined);
  try {
    const dir = await remoteSpawnDir(host, body.dir, body.remoteDir || undefined);
    const args = ["new", body.name, "--no-jump"];
    if (body.task) args.push("-m", "-");
    if (dir) args.push("--dir", dir);
    if (body.inPlace === true) args.push("--in-place");
    if (provider) args.push(`--${provider}`);
    if (body.model) args.push("--model", body.model);
    if (body.effort) args.push("--effort", body.effort);
    if (body.role) args.push("--role", body.role);
    await runRemoteAm(host, args, { stdin: body.task || undefined, timeoutMs: REMOTE_NEW_TIMEOUT_MS });
    return json({ ok: true, name: body.name, host }, 201);
  } catch (error) {
    return remoteFailure(error);
  }
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

  if (parts.length === 1 && parts[0] === "roles" && method === "GET") {
    return json({ roles: listRoles() });
  }

  // GET /api/summary — the same prioritized fleet report as `am summary`.
  if (parts.length === 1 && parts[0] === "summary" && method === "GET") {
    return json(buildFleetSummary(cachedFleetRows()));
  }

  // GET /api/events — authenticated proxy of the daemon's fleet event stream.
  // Remote clients can update immediately without exposing the unix socket.
  if (parts.length === 1 && parts[0] === "events" && method === "GET") {
    const upstream = await daemonRequest("/events", { timeoutMs: 0, signal: req.signal });
    if (!upstream?.ok || !upstream.body) return json({ error: "daemon unavailable" }, 503);
    return new Response(upstream.body, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
      },
    });
  }

  // GET /api/hosts — this machine plus config.remotes, for a host picker.
  if (parts.length === 1 && parts[0] === "hosts" && method === "GET") {
    const { unreachable } = cachedFleetRows();
    return json({
      local: localHostIdentity(),
      hosts: (loadConfig().remotes ?? []).map((name) => ({ name, reachable: !unreachable.includes(name) })),
    });
  }

  // POST /api/agents — spawn a new agent (on `host` when set)
  if (parts.length === 1 && parts[0] === "agents" && method === "POST") {
    const body = (await req.json().catch(() => null)) as SpawnBody | null;
    if (!body?.name) return json({ error: "name required" }, 400);
    for (const field of ["model", "effort"] as const) {
      if (body[field] != null && typeof body[field] !== "string") return json({ error: `${field} must be a string` }, 400);
    }
    // `provider` names either one; the older boolean `codex` only ever meant
    // "not the default", so it can't ask for claude now that codex IS the
    // default — clients that want claude send provider.
    if (body.provider && body.provider !== "claude" && body.provider !== "codex") {
      return json({ error: `provider must be "claude" or "codex"` }, 400);
    }
    for (const field of ["task", "role", "dir", "remoteDir"] as const) {
      if (body[field] != null && typeof body[field] !== "string") return json({ error: `${field} must be a string` }, 400);
    }
    if (body.host != null) {
      if (typeof body.host !== "string" || !HOST_RE.test(body.host)) return json({ error: "invalid host" }, 400);
      const host = resolveHost(body.host);
      if (host === undefined) return json({ error: `unknown host "${body.host}" (not in config.remotes)` }, 404);
      if (host !== null) return spawnRemote(host, { ...body, name: body.name });
    }
    try {
      await newCommand({
        name: body.name,
        message: body.task,
        dir: body.dir,
        provider: (body.provider as Provider | undefined) ?? (body.codex ? "codex" : undefined),
        role: body.role,
        model: body.model || undefined,
        effort: body.effort || undefined,
        inPlace: body.inPlace === true,
        jump: false,
        quiet: true,
      });
      return json({ ok: true, name: body.name }, 201);
    } catch (error) {
      return json({ error: (error as Error).message }, 409);
    }
  }

  // /api/agents/:name[/...] — :name may be host:name
  if (parts[0] === "agents" && parts.length >= 2) {
    const target = parseTarget(parts[1]!);
    if (target instanceof Response) return target;
    if (target.host) return handleRemoteAgent(req, target.host, target.name, parts.slice(2));
    const { name } = target;

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

    // GET /api/agents/:name/transcript?after=n — see transcriptJson
    if (parts.length === 3 && parts[2] === "transcript" && method === "GET") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      const raw = new URL(req.url).searchParams.get("after");
      const after = raw === null || raw === "" ? 0 : Number(raw);
      if (!Number.isInteger(after) || after < 0) return json({ error: "after must be a non-negative integer" }, 400);
      return json(transcriptJson(agent, after));
    }

    // POST /api/agents/:name/interrupt — {text?}: Esc, then send text if given
    if (parts.length === 3 && parts[2] === "interrupt" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      if (body?.text != null && typeof body.text !== "string") return json({ error: "text must be a string" }, 400);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      try {
        if (text) await interruptCommand(agent.name, text, { exact: true });
        else await abortTurn(agent.name);
        return json({ ok: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 409);
      }
    }

    // POST /api/agents/:name/rename — {name}
    if (parts.length === 3 && parts[2] === "rename" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { name?: string } | null;
      if (!body?.name) return json({ error: "name required" }, 400);
      try {
        const result = await renameAgent(name, body.name);
        return json({ ok: true, oldName: result.oldName, name: result.newName, live: result.live });
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
        // Bearer header only. The old `?token=` query fallback existed for
        // the PWA's URL bootstrap; with that gone it would just leak the
        // token (an RCE credential) into proxy logs and shell history.
        const supplied = bearer(req);
        if (!supplied || !tokensMatch(supplied, token)) {
          return json({ error: "unauthorized" }, 401);
        }
        const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
        return handleApi(req, parts);
      }

      // PWA tombstones: phones that installed the old web app still hold its
      // service worker, which would cache a raw 404 over the shell. Hand the
      // update check a self-destructing worker (drop caches, unregister,
      // reload) and a one-line page so the stranded icon explains itself.
      if (path === "/sw.js") {
        return new Response(SW_TOMBSTONE, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      if (path === "/" || path === "/index.html") {
        return new Response(PWA_GONE_HTML, {
          status: 410,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
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
