// Route handlers of the fixture am server, one group per area. Each mirrors
// the real route in src/server.ts: the same validation order, statuses, error
// strings and `reason` values, including the quirks a client has to survive.
import { checkMessageText } from "../src/policy";
import type { QueueItem, TranscriptEntry } from "../src/types";
import { FIXTURE_HOME, FIXTURE_LOCAL_HOST, FIXTURE_REMOTE_HOSTS, REPO, worktree, type FixtureRow } from "./data";
import { catalogsFor, findCatalog, ROLES, seedWorkspace, selectionError, type Workspace } from "./extras";
import { ulid, type FixtureState, type Message } from "./store";
import { agentTokenReport, fleetTokenReport, quota, usageSummary } from "./usage";

// Stays working for the whole run, so a message queued to it can always be cancelled.
export const PINNED_BUSY_AGENT = "harbor-lights";
// Holds its lifecycle lock for the whole run (mid-move): lifecycle routes refuse it.
export const LOCKED_AGENT = "slipway";
const DRIFTING_AGENT = "drift-net";
const STOPPED = new Set(["exited", "dead"]);
const RUNNING = ["starting", "idle", "waiting", "working", "needs-attention"];
const REPLY = "Got it. I'll fold that in and report back here when it's done.";
const FIRST_REPLY = "Read the task and the repository layout. Starting with the parts the task names; I'll report back here.";
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HOST_RE = /^[a-zA-Z0-9_.-]+$/;
const PROVIDERS = ["claude", "codex", "antigravity"];
const UNREACHABLE = FIXTURE_REMOTE_HOSTS.filter((host) => !host.reachable).map((host) => host.name);
export const PASTE_MAX_BYTES = 10 * 1024 * 1024;

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  // null when absent or not JSON (like `req.json().catch(() => null)`).
  body: unknown;
  bytes?: Uint8Array;
}
export interface Route {
  method: string;
  path: string;
  handler: (ctx: Ctx) => Response | Promise<Response>;
}

export interface Fx {
  state(): FixtureState;
  broadcast(event: string, data: unknown): void;
  later(ms: number, fn: () => void): void;
  deliverMs: number;
  replyMs: number;
  transitionMs: number;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function buildRoutes(fx: Fx): { routes: Route[]; flipDrift(): void } {
  const s = () => fx.state();

  const resolveHost = (host: string): string | null | undefined =>
    host === "local" || host === FIXTURE_LOCAL_HOST ? null : FIXTURE_REMOTE_HOSTS.some((item) => item.name === host) ? host : undefined;
  const sshDown = (host: string) => `ssh ${host}: connect to host ${host} port 22: Operation timed out`;

  interface Target { host: string | null; name: string }
  function parseTarget(raw: string): Target | Response {
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
  const keyOf = (row: FixtureRow) => (row.host ? `${row.host}:${row.name}` : row.name);
  const hostRows = (host: string | null) => s().rows.filter((row) => (row.host ?? null) === host);
  // The row, or the error the real route gives: ssh failure for an unreachable
  // host, the remote am's "no agent matches", or the local route's own 404.
  function agentOf(target: Target, localMissing = `no local agent "${target.name}"`): FixtureRow | Response {
    if (target.host && UNREACHABLE.includes(target.host)) return json({ error: sshDown(target.host) }, 502);
    const row = hostRows(target.host).find((candidate) => candidate.name === target.name);
    if (row) return row;
    return json({ error: target.host ? `no agent matches "${target.name}"` : localMissing }, 404);
  }
  // `matchAgent`: exact name, then an alias, then a unique prefix (local POST /stop and /api/usage?agent=).
  function matchLocal(prefix: string): FixtureRow {
    const rows = hostRows(null);
    const exact = rows.find((row) => row.name === prefix);
    if (exact) return exact;
    const aliased = rows.filter((row) => row.aliases?.includes(prefix));
    if (aliased.length === 1) return aliased[0]!;
    if (aliased.length > 1) throw new Error(`"${prefix}" is an alias for multiple agents: ${aliased.map((row) => row.name).join(", ")}`);
    const matches = rows.filter((row) => row.name.startsWith(prefix));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`"${prefix}" is ambiguous: ${matches.map((row) => row.name).join(", ")}`);
    throw new Error(`no agent matches "${prefix}"`);
  }
  const isPinned = (row: FixtureRow) => row.name === PINNED_BUSY_AGENT && !row.host;
  const isLocked = (row: FixtureRow) => row.name === LOCKED_AGENT && !row.host;
  const lifecycleBusy = (row: FixtureRow, suffix = "") => `agent "${row.name}" is being stopped, removed, renamed, or restarted — retry${suffix}`;

  function setStatus(row: FixtureRow, status: FixtureRow["status"]) {
    const now = new Date().toISOString();
    if (row.status !== status) row.statusChangedAt = now;
    row.status = status;
    row.updatedAt = now;
    if (status === "working") row.workingSince ??= now;
    else delete row.workingSince;
  }
  // Richer than the real stream, which sends only `{id, type: "fleet", event, agent?, at}` and only for
  // local agents: UI code must treat these as refresh cues and never read `status`, `host` or `type` here.
  const emitStatus = (row: FixtureRow) => fx.broadcast("fleet", { type: "status", agent: row.name, host: row.host, status: row.status, at: row.updatedAt });
  const emit = (type: string, row: FixtureRow, extra: Record<string, unknown> = {}) =>
    fx.broadcast("fleet", { type, agent: row.name, host: row.host, ...extra, at: new Date().toISOString() });
  function bump(row: FixtureRow) {
    s().epochs.set(row, (s().epochs.get(row) ?? 0) + 1);
    s().delivering.delete(row);
  }
  // A timer that does nothing if the agent was removed or went through another lifecycle action meanwhile.
  function laterFor(row: FixtureRow, ms: number, fn: () => void) {
    const state = s();
    const epoch = state.epochs.get(row) ?? 0;
    fx.later(ms, () => {
      if (fx.state() !== state || !state.rows.includes(row) || (state.epochs.get(row) ?? 0) !== epoch) return;
      fn();
    });
  }
  const appendEntry = (row: FixtureRow, entry: { kind: "user" | "assistant"; text: string }) => {
    const entries: TranscriptEntry[] = s().transcripts.get(row) ?? [];
    entries.push({ ...entry, index: (entries.at(-1)?.index ?? -1) + 1 });
    s().transcripts.set(row, entries);
  };
  // resume, restart, model change, move: starting, then idle (the pinned agent: working) after transitionMs.
  function boot(row: FixtureRow) {
    bump(row);
    delete row.statusReason;
    setStatus(row, "starting");
    emitStatus(row);
    laterFor(row, fx.transitionMs, () => {
      setStatus(row, isPinned(row) ? "working" : "idle");
      emitStatus(row);
      drain(row);
    });
  }
  // create, handoff: starting → working on the task → idle with a first reply.
  function spawn(row: FixtureRow, task: string | undefined) {
    const state = s();
    state.rows.push(row);
    state.transcripts.set(row, []);
    emit("created", row);
    emitStatus(row);
    laterFor(row, fx.transitionMs, () => {
      if (!task) {
        setStatus(row, "idle");
        emitStatus(row);
        return drain(row);
      }
      appendEntry(row, { kind: "user", text: task });
      setStatus(row, "working");
      emitStatus(row);
      laterFor(row, fx.transitionMs, () => {
        appendEntry(row, { kind: "assistant", text: FIRST_REPLY });
        setStatus(row, "idle");
        emitStatus(row);
        drain(row);
      });
    });
  }
  function newRow(fields: { name: string; host: string | null; provider: FixtureRow["provider"]; dir: string; task?: string; model?: string; effort?: string; role?: string }): FixtureRow {
    const now = new Date().toISOString();
    const row: FixtureRow = { name: fields.name, status: "starting", statusChangedAt: now, provider: fields.provider, dir: fields.dir, createdAt: now, updatedAt: now };
    if (fields.host) row.host = fields.host;
    const repo = Object.values(REPO).find((root) => fields.dir === root);
    if (repo) {
      const repoName = repo.split("/").pop()!;
      row.repoRoot = repo;
      row.dir = worktree(repoName, fields.name);
      row.worktreeBranch = `am/${fields.name}`;
    }
    if (fields.model) row.model = fields.model;
    if (fields.effort) row.effort = fields.effort;
    if (fields.task) row.task = fields.task;
    if (fields.role) row.role = fields.role;
    return row;
  }

  const queueOf = (row: FixtureRow) => s().queues.get(row) ?? [];
  // Like am, only `queue` messages are listed; a `now` message goes straight to the pane.
  const listedOf = (row: FixtureRow) => queueOf(row).filter((item) => item.mode === "queue");
  const syncQueued = (row: FixtureRow) => {
    const count = listedOf(row).length;
    if (count) row.queued = count;
    else delete row.queued;
  };
  // Accepted → (deliverMs) user turn, agent working → (replyMs) canned reply, agent idle.
  function deliver(row: FixtureRow, message: Message): void {
    s().delivering.add(row);
    laterFor(row, fx.deliverMs, () => {
      if (message.state !== "queued") {
        s().delivering.delete(row);
        drain(row);
        return;
      }
      message.state = "delivered";
      s().queues.set(row, queueOf(row).filter((item) => item !== message));
      syncQueued(row);
      appendEntry(row, { kind: "user", text: message.text });
      setStatus(row, "working");
      fx.broadcast("fleet", { type: "message", agent: row.name, host: row.host, id: message.id, state: "delivered" });
      laterFor(row, fx.replyMs, () => {
        appendEntry(row, { kind: "assistant", text: REPLY });
        s().delivering.delete(row);
        if (!isPinned(row)) setStatus(row, "idle");
        else row.updatedAt = new Date().toISOString();
        emitStatus(row);
        drain(row);
      });
    });
  }
  // One delivery at a time: the oldest `now` message, or the oldest of any once the agent is idle.
  function drain(row: FixtureRow): void {
    if (s().delivering.has(row)) return;
    const next = queueOf(row).find((item) => item.state === "queued" && (item.mode === "now" || row.status === "idle"));
    if (next) deliver(row, next);
  }

  function postMessage(ctx: Ctx): Response {
    const key = decodeKey(ctx.params.key!);
    const data = isObject(ctx.body) ? (ctx.body as { text?: unknown; mode?: unknown }) : {};
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) return json({ error: "text required" }, 400);
    const checked = checkMessageText(data.text);
    if (!checked.ok) return json({ error: checked.error }, 400);
    if (data.mode !== "queue" && data.mode !== "now") return json({ error: "mode must be queue or now" }, 400);
    const row = findByKey(key);
    if (!row) return json({ error: `no agent "${key}"` }, 404);
    if (STOPPED.has(row.status)) return json({ error: `agent "${key}" has no live tmux session`, reason: "no_session" }, 409);
    const message: Message = { id: ulid(), row, text, mode: data.mode, state: "queued", queuedAt: new Date().toISOString() };
    s().messages.set(message.id, message);
    s().queues.set(row, [...queueOf(row), message]);
    syncQueued(row);
    row.updatedAt = new Date().toISOString();
    fx.broadcast("fleet", { type: "message", agent: row.name, host: row.host, id: message.id, state: "queued" });
    drain(row);
    return json({ ok: true, mode: data.mode, id: message.id });
  }

  function cancelMessage(ctx: Ctx): Response {
    const key = decodeKey(ctx.params.key!);
    const rawId = decodeKey(ctx.params.id!) ?? "";
    const row = findByKey(key);
    if (!row) return json({ error: `no agent "${key}"` }, 404);
    const message = s().messages.get(rawId);
    if (!message || message.row !== row) return json({ error: `no message "${rawId}" for agent "${key}"` }, 404);
    if (message.state === "delivered" || message.mode === "now") return json({ error: "message was already delivered", reason: "already_delivered", state: "delivered" }, 409);
    if (message.state === "cancelled") return json({ error: "message was already cancelled", reason: "already_cancelled", state: "cancelled" }, 409);
    message.state = "cancelled";
    s().queues.set(row, queueOf(row).filter((item) => item !== message));
    syncQueued(row);
    row.updatedAt = new Date().toISOString();
    fx.broadcast("fleet", { type: "message", agent: row.name, host: row.host, id: message.id, state: "cancelled" });
    return json({ ok: true, state: "cancelled" });
  }

  function decodeKey(raw: string): string | null {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  const findByKey = (key: string | null) => (key === null ? undefined : s().rows.find((row) => keyOf(row) === key));

  const withTarget = (handler: (ctx: Ctx, target: Target) => Response | Promise<Response>) => (ctx: Ctx) => {
    const target = parseTarget(ctx.params.key!);
    return target instanceof Response ? target : handler(ctx, target);
  };

  function detail(row: FixtureRow) {
    const native = row.provider !== "antigravity";
    const prompt = s().prompts.get(row);
    const runtime = {
      model: row.model ?? null, effort: row.effort ?? null,
      modelSource: row.model ? "configured" : "unknown", effortSource: row.effort ? "configured" : "unknown",
    };
    return {
      ...row,
      statusReason: row.statusReason ?? null,
      capabilities: {
        remoteControl: native, quota: native, approvalRelay: native, interruptByReceipt: native,
        handoff: native, move: native, rename: native, subagents: native, attachments: native,
      },
      runtime,
      model: row.model ?? null,
      effort: row.effort ?? null,
      role: typeof row.role === "string" ? row.role : null,
      task: row.task ?? null,
      worktreeBranch: row.worktreeBranch ?? null,
      // Like am, an API-queued entry carries no msgId; its record id stays internal.
      queue: listedOf(row).map((item): QueueItem => ({ message: item.text, queuedAt: item.queuedAt, ...(item.peerMsgId ? { msgId: item.peerMsgId } : {}) })),
      pane: STOPPED.has(row.status) ? null : "",
      messageReceipts: true,
      terminalAttach: 1,
      panePrompt: row.provider === "claude" && prompt && !prompt.consumed ? prompt.prompt : null,
      permissionRequests: native,
      interruptByReceipt: native,
      pendingPermissions: s().permissions.filter((record) => record.row === row && record.state === "pending").length,
    };
  }

  const readRoutes: Route[] = [
    { method: "GET", path: "/api/health", handler: () => json({ ok: true, name: "am" }) },
    { method: "GET", path: "/api/concierge", handler: () => json({ key: "concierge" }) },
    { method: "GET", path: "/api/hosts", handler: () => json({ local: FIXTURE_LOCAL_HOST, hosts: FIXTURE_REMOTE_HOSTS }) },
    { method: "GET", path: "/api/agents", handler: () => json({ rows: s().rows, unreachable: UNREACHABLE }) },
    {
      method: "GET", path: "/api/agents/:key", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        return row instanceof Response ? row : json(detail(row));
      }),
    },
    {
      method: "GET", path: "/api/agents/:key/transcript", handler: withTarget((ctx, target) => {
        const row = agentOf(target);
        if (row instanceof Response) return row;
        const subagent = ctx.url.searchParams.get("subagent");
        if (subagent !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(subagent)) return json({ error: "invalid subagent id" }, 400);
        if (subagent !== null) {
          const found = (s().subagents.get(row) ?? []).find((item) => item.record.id === subagent);
          if (!found) return json({ error: `no subagent matches "${subagent}" for agent "${row.name}"` }, 409);
          if (!found.entries) {
            return json({ error: `codex keeps subagent turns out of the parent session — "${found.record.type}" has no transcript of its own (it is still running)` }, 409);
          }
          return json({
            provider: row.provider, sessionId: `fixture-${row.name}-${subagent}`, status: found.record.endedAt ? "exited" : row.status,
            total: found.entries.length, entries: found.entries,
          });
        }
        const entries = s().transcripts.get(row) ?? [];
        return json({ provider: row.provider, sessionId: `fixture-${row.name}`, status: row.status, total: entries.length, entries });
      }),
    },
    { method: "POST", path: "/api/agents/:key/messages", handler: postMessage },
    { method: "DELETE", path: "/api/agents/:key/messages/:id", handler: cancelMessage },
  ];

  // `refuseFields`: conditional stops and restarts are CLI-only.
  const refuse = (body: unknown, fields: string[]) => {
    const sent = isObject(body) ? fields.find((field) => Object.hasOwn(body, field)) : undefined;
    return sent ? json({ error: `${sent} is not supported${sent === "ifIdle" ? "; use `am stop --if-idle`" : ""}` }, 400) : null;
  };

  const lifecycleRoutes: Route[] = [
    {
      method: "POST", path: "/api/agents/:key/resume", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        if (row instanceof Response) return row;
        // A live session makes resume a no-op.
        if (!STOPPED.has(row.status)) return json({ ok: true });
        if (row.name === "ghost-pier") {
          const error = `agent directory no longer exists: ${row.dir}`;
          return json(row.host ? { error, reason: "no_session" } : { error }, 409);
        }
        boot(row);
        return json({ ok: true });
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/restart", handler: withTarget((ctx, target) => {
        const refused = refuse(ctx.body, ["ifIdle", "model", "effort"]);
        if (refused) return refused;
        const row = agentOf(target);
        if (row instanceof Response) return row;
        if (isLocked(row)) return json({ error: lifecycleBusy(row, " restart") }, 409);
        boot(row);
        return json({ ok: true });
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/interrupt", handler: withTarget((ctx, target) => {
        const body = ctx.body;
        if (isObject(body) && Object.hasOwn(body, "messageId")) return json({ error: "messageId is not supported" }, 400);
        if (isObject(body) && body.text != null && typeof body.text !== "string") return json({ error: "text must be a string" }, 400);
        const text = isObject(body) && typeof body.text === "string" ? body.text.trim() : "";
        const row = agentOf(target);
        if (row instanceof Response) return row;
        if (STOPPED.has(row.status)) {
          return json({ error: `agent "${row.name}" has no live tmux session (status: ${row.status})`, reason: "no_session" }, 409);
        }
        if (text) {
          // Esc, then the text typed as a new turn.
          bump(row);
          appendEntry(row, { kind: "user", text });
          setStatus(row, "working");
          emitStatus(row);
        } else if (["working", "waiting", "needs-attention"].includes(row.status)) {
          // Esc aborts the turn. The pinned agent picks its next step straight back up.
          bump(row);
          if (!isPinned(row)) {
            delete row.statusReason;
            setStatus(row, "idle");
          } else row.updatedAt = new Date().toISOString();
          emitStatus(row);
          drain(row);
        }
        return json({ ok: true });
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/stop", handler: withTarget((ctx, target) => {
        const refused = refuse(ctx.body, ["ifIdle"]);
        if (refused) return refused;
        let row: FixtureRow;
        if (target.host) {
          const found = agentOf(target);
          if (found instanceof Response) return found;
          row = found;
        } else {
          // Quirk: local stop resolves aliases and unique prefixes, and every error is a 404.
          try {
            row = matchLocal(target.name);
          } catch (error) {
            return json({ error: (error as Error).message }, 404);
          }
          if (isLocked(row)) return json({ error: lifecycleBusy(row) }, 404);
        }
        if (row.status !== "exited") {
          bump(row);
          setStatus(row, "exited");
          row.statusReason = "stopped by operator";
          emitStatus(row);
        }
        return json({ ok: true });
      }),
    },
    {
      method: "DELETE", path: "/api/agents/:key", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        if (row instanceof Response) return row;
        // Quirk: the local route lets destroyAgent's lifecycle-busy throw escape as a 500.
        if (isLocked(row)) return json({ error: "request failed" }, 500);
        const state = s();
        bump(row);
        state.rows.splice(state.rows.indexOf(row), 1);
        for (const message of queueOf(row)) state.messages.delete(message.id);
        state.queues.delete(row);
        state.transcripts.delete(row);
        state.prompts.delete(row);
        state.subagents.delete(row);
        state.workspaces.delete(row);
        state.permissions = state.permissions.filter((record) => record.row !== row);
        const history = state.histories.get(row);
        if (history) {
          state.histories.delete(row);
          state.removed.push({ ...history, removed: true });
        }
        emit("removed", row);
        return json({ ok: true });
      }),
    },
  ];

  const ownerOf = (host: string | null, name: string) => hostRows(host).find((row) => row.name === name || row.aliases?.includes(name));

  const manageRoutes: Route[] = [
    {
      method: "POST", path: "/api/agents/:key/rename", handler: withTarget((ctx, target) => {
        const name = isObject(ctx.body) ? ctx.body.name : undefined;
        if (typeof name !== "string" || !AGENT_NAME_RE.test(name) || name.length > 64) {
          return json({ error: target.host ? "Use a name of 1–64 letters, numbers, dashes or underscores" : "valid name required (1–64 characters)" }, 400);
        }
        const row = agentOf(target, "agent not found");
        if (row instanceof Response) return row;
        const oldName = row.name;
        const live = !STOPPED.has(row.status);
        const done = () => json(target.host ? { ok: true, name, key: `${target.host}:${name}` } : { ok: true, oldName, name, live });
        if (row.provider === "antigravity") return json({ error: "Antigravity rename is unsupported; its runner is bound to the launch identity" }, 409);
        if (name === oldName) return done();
        if (isLocked(row)) return json({ error: lifecycleBusy(row, " the rename") }, 409);
        if (name === "concierge") return json({ error: '"concierge" is reserved for the fleet concierge — open it with `am concierge`' }, 409);
        if (oldName === "concierge") return json({ error: "the fleet concierge cannot be renamed — remove it with `am rm concierge` if you no longer want it" }, 409);
        const owner = ownerOf(target.host, name);
        if (owner && owner !== row) {
          return json({ error: `agent name "${name}" is already used by ${owner.name === name ? "agent" : `alias for "${owner.name}"`}` }, 409);
        }
        row.aliases = [...(row.aliases ?? []), oldName];
        row.name = name;
        row.updatedAt = new Date().toISOString();
        emit("renamed", row, { oldName });
        return done();
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/move", handler: withTarget((ctx, target) => {
        const body = isObject(ctx.body) ? ctx.body : null;
        if (typeof body?.host !== "string" || !HOST_RE.test(body.host)) return json({ error: "destination host required" }, 400);
        const destination = resolveHost(body.host);
        if (destination === undefined) return json({ error: "unknown destination host" }, 404);
        if (destination === target.host || (destination && target.host)) return json({ error: "Move between this server and one configured remote host" }, 400);
        if (body.dir !== undefined && (typeof body.dir !== "string" || !body.dir.startsWith("/") || body.dir.includes("\0"))) {
          return json({ error: "destination directory must be an absolute path" }, 400);
        }
        const row = agentOf(target, "agent not found");
        if (row instanceof Response) return row;
        if (isLocked(row)) return json({ error: lifecycleBusy(row) }, 409);
        if (destination && UNREACHABLE.includes(destination)) return json({ error: sshDown(destination) }, 409);
        if (ownerOf(destination, row.name)) {
          return json({ error: `agent "${row.name}" already exists — restart it with \`am resume ${row.name}\`` }, 409);
        }
        const from = row.host ?? FIXTURE_LOCAL_HOST;
        if (destination) row.host = destination;
        else delete row.host;
        if (typeof body.dir === "string" && body.dir) row.dir = body.dir;
        // The provider restarts on the destination: relay requests and pane prompts don't survive it.
        s().permissions = s().permissions.filter((record) => record.row !== row || record.state !== "pending");
        s().prompts.delete(row);
        emit("moved", row, { from });
        boot(row);
        const key = destination ? `${destination}:${row.name}` : row.name;
        return json({ ok: true, key, message: `moved ${row.name} from ${from} to ${destination ?? FIXTURE_LOCAL_HOST} (workspace files were not copied)` });
      }),
    },
  ];

  function modelBody(value: unknown): { model: string | null; effort?: string | null; createdAt: string; status: string } | Response {
    const body = value as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || typeof body !== "object") return json({ error: "JSON object required" }, 400);
    const extra = Object.keys(body).find((field) => !["model", "effort", "createdAt", "status"].includes(field));
    if (extra) return json({ error: `${extra} is not supported` }, 400);
    if (!Object.hasOwn(body, "model")) return json({ error: "model is required" }, 400);
    if (typeof body.createdAt !== "string" || !body.createdAt || body.createdAt.length > 128 || /[\x00-\x1f\x7f]/.test(body.createdAt)) {
      return json({ error: "createdAt is required" }, 400);
    }
    if (typeof body.status !== "string" || !RUNNING.includes(body.status)) return json({ error: "status must identify a running agent" }, 400);
    for (const [field, limit] of [["model", 256], ["effort", 64]] as const) {
      if (!Object.hasOwn(body, field)) continue;
      const value = body[field];
      if (value !== null && typeof value !== "string") return json({ error: `${field} must be a string or null` }, 400);
      if (typeof value === "string" && (!value.length || value.length > limit || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-"))) {
        return json({ error: `${field} is invalid` }, 400);
      }
    }
    return body as { model: string | null; effort?: string | null; createdAt: string; status: string };
  }

  function uniqueName(host: string | null, base: string): string | null {
    const taken = (name: string) => hostRows(host).some((row) => row.name === name);
    if (!taken(base)) return base;
    for (let i = 2; i < 100; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
    return null;
  }

  const knownDirs = () => new Set([FIXTURE_HOME, `${FIXTURE_HOME}/code`, ...Object.values(REPO), ...s().rows.map((row) => row.dir)]);

  const agentSetupRoutes: Route[] = [
    {
      method: "GET", path: "/api/models", handler: (ctx) => {
        const raw = ctx.url.searchParams.get("host");
        let host: string | null = null;
        if (raw) {
          if (!HOST_RE.test(raw)) return json({ error: `invalid host "${raw}"` }, 400);
          const resolved = resolveHost(raw);
          if (resolved === undefined) return json({ error: `unknown host "${raw}" (not in config.remotes)` }, 404);
          if (resolved && UNREACHABLE.includes(resolved)) return json({ error: sshDown(resolved) }, 502);
          host = resolved;
        }
        return json(catalogsFor(host));
      },
    },
    { method: "GET", path: "/api/roles", handler: () => json({ roles: ROLES }) },
    {
      method: "POST", path: "/api/agents/:key/model", handler: withTarget((ctx, target) => {
        const body = modelBody(ctx.body);
        if (body instanceof Response) return body;
        const row = agentOf(target);
        if (row instanceof Response) return row;
        // Display status, checked exactly: a working→idle flip since the dialog opened is a 409.
        if (row.createdAt !== body.createdAt || row.status !== body.status) {
          return json({ error: `agent "${row.name}" changed or stopped since it was selected — refresh and try again` }, 409);
        }
        const rejected = selectionError(findCatalog(row.host ?? null, row.provider), body.model, body.effort);
        if (rejected) return json({ error: rejected }, 400);
        if (isLocked(row)) return json({ error: lifecycleBusy(row, " restart") }, 409);
        if (body.model === null) delete row.model;
        else row.model = body.model;
        if (body.effort === null) delete row.effort;
        else if (body.effort !== undefined) row.effort = body.effort;
        boot(row);
        return json(target.host
          ? { ok: true, model: body.model, ...(body.effort !== undefined ? { effort: body.effort } : {}) }
          : { ok: true, model: row.model ?? null, effort: row.effort ?? null });
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/handoff", handler: withTarget((ctx, target) => {
        const body = isObject(ctx.body) ? ctx.body : null;
        if (body?.to === "antigravity") return json({ error: "antigravity handoff is unsupported" }, 400);
        if (!body || (body.to !== "claude" && body.to !== "codex")) return json({ error: "to must be claude or codex" }, 400);
        if (body.newName !== undefined && (typeof body.newName !== "string" || !AGENT_NAME_RE.test(body.newName) || body.newName.length > 64)) {
          return json({ error: "newName must be 1–64 letters, numbers, dashes or underscores" }, 400);
        }
        if (body.full !== undefined && typeof body.full !== "boolean") return json({ error: "full must be a boolean" }, 400);
        const source = agentOf(target);
        if (source instanceof Response) return source;
        if (source.provider === "antigravity") {
          return json({ error: target.host ? "Antigravity handoff is unsupported; use am transcript and an explicit new task" : "antigravity handoff is unsupported" }, 409);
        }
        if (!(s().transcripts.get(source) ?? []).length) return json({ error: `agent "${source.name}" has an empty transcript — nothing to hand off` }, 409);
        // Quirk: a taken name is silently suffixed (name2 … name99), never refused.
        const base = (body.newName as string | undefined) ?? `${source.name}-${body.to}`;
        const name = uniqueName(target.host, base);
        if (!name) return json({ error: `could not find a free name for ${base}` }, 409);
        if (name === "concierge") return json({ error: '"concierge" is reserved for the fleet concierge — open it with `am concierge` (c in the hub)' }, 409);
        const task = [
          `You are taking over work from the agent "${source.name}" (running on ${source.host ?? FIXTURE_LOCAL_HOST}). The full transcript of its conversation is at:`,
          "",
          `  ${FIXTURE_HOME}/.agent-manager/handoffs/${source.name}-to-${body.to}-fixture.md`,
          "",
          `Its task was: ${source.task?.split("\n")[0] ?? "(none)"}`,
        ].join("\n");
        const row = newRow({ name, host: target.host, provider: body.to, dir: source.repoRoot ?? source.dir, task, ...(typeof source.role === "string" ? { role: source.role } : {}) });
        spawn(row, task);
        return json({ ok: true, name, target: body.to, key: target.host ? `${target.host}:${name}` : name }, 201);
      }),
    },
    {
      method: "POST", path: "/api/agents", handler: (ctx) => {
        const body = (isObject(ctx.body) ? ctx.body : null) as Record<string, unknown> | null;
        if (!body?.name) return json({ error: "name required" }, 400);
        for (const field of ["model", "effort"]) {
          if (body[field] != null && typeof body[field] !== "string") return json({ error: `${field} must be a string` }, 400);
        }
        if (body.provider !== undefined && !PROVIDERS.includes(body.provider as string)) return json({ error: "provider must be claude, codex, or antigravity" }, 400);
        if (body.codex !== undefined && typeof body.codex !== "boolean") return json({ error: "codex must be a boolean" }, 400);
        if (body.provider !== undefined && body.codex !== undefined && (body.provider === "codex") !== body.codex) {
          return json({ error: "contradictory provider and codex selection" }, 400);
        }
        for (const field of ["task", "role", "dir", "remoteDir"]) {
          if (body[field] != null && typeof body[field] !== "string") return json({ error: `${field} must be a string` }, 400);
        }
        const name = String(body.name);
        const provider = (body.provider as FixtureRow["provider"] | undefined) ?? (body.codex === false ? "claude" : "codex");
        const task = (body.task as string | undefined) || undefined;
        const model = (body.model as string | undefined) || undefined;
        const effort = (body.effort as string | undefined) || undefined;
        const role = (body.role as string | undefined) || undefined;
        let host: string | null = null;
        if (body.host != null) {
          if (typeof body.host !== "string" || !HOST_RE.test(body.host)) return json({ error: "invalid host" }, 400);
          const resolved = resolveHost(body.host);
          if (resolved === undefined) return json({ error: `unknown host "${body.host}" (not in config.remotes)` }, 404);
          host = resolved;
        }
        if (host) {
          // spawnRemote: `am new` over ssh; its refusals arrive as remote errors.
          if (typeof body.name !== "string" || !AGENT_NAME_RE.test(name)) return json({ error: "agent name must be alphanumeric with dashes/underscores" }, 409);
          if (body.remoteDir != null && !(body.remoteDir as string).startsWith("/")) return json({ error: "remoteDir must be an absolute path" }, 400);
          if (body.dir != null && !(body.dir as string).startsWith("/")) return json({ error: "dir must be an absolute path" }, 400);
          const remoteDir = (body.remoteDir as string | undefined) || undefined;
          const dir = (body.dir as string | undefined) || undefined;
          if (!remoteDir && dir && dir !== FIXTURE_HOME && !dir.startsWith(`${FIXTURE_HOME}/`)) {
            return json({ error: `dir ${dir} is not under ${FIXTURE_HOME} — pass remoteDir for ${host}` }, 400);
          }
          if (UNREACHABLE.includes(host)) return json({ error: sshDown(host) }, 502);
          // The fixture does not model the remote filesystem: any absolute directory exists there.
          const refusal = newRefusal(host, name, role, provider, model, effort);
          // A remote catalog refusal matches remoteAgents' 400 pattern; everything else is a 409.
          if (refusal) return json({ error: refusal.error }, refusal.selection ? 400 : 409);
          spawn(newRow({ name, host, provider, dir: remoteDir ?? dir ?? FIXTURE_HOME, task, model, effort, role }), task);
          return json({ ok: true, name, host }, 201);
        }
        const dir = typeof body.dir === "string" && body.dir ? body.dir.replace(/^~(?=\/|$)/, FIXTURE_HOME) : FIXTURE_HOME;
        const refusal = newRefusal(null, name, role, provider, model, effort, dir);
        // Locally every newCommand throw is a 409, catalog refusals included.
        if (refusal) return json({ error: refusal.error }, 409);
        spawn(newRow({ name, host: null, provider, dir, task, model, effort, role }), task);
        return json({ ok: true, name }, 201);
      },
    },
    {
      method: "POST", path: "/api/concierge", handler: () => {
        const row = hostRows(null).find((candidate) => candidate.name === "concierge");
        if (!row) spawn(newRow({ name: "concierge", host: null, provider: "claude", dir: FIXTURE_HOME, role: "concierge", model: "claude-sonnet-4-5" }), undefined);
        else if (STOPPED.has(row.status)) boot(row);
        return json({ key: "concierge" });
      },
    },
  ];

  // newCommand's checks, in its order.
  function newRefusal(host: string | null, name: string, role: string | undefined, provider: string, model?: string, effort?: string, dir?: string): { error: string; selection?: true } | null {
    if (!AGENT_NAME_RE.test(name)) return { error: "agent name must be alphanumeric with dashes/underscores" };
    if (name === "concierge") return { error: '"concierge" is reserved for the fleet concierge — open it with `am concierge` (c in the hub)' };
    if (role === "concierge") return { error: 'role "concierge" is reserved for the fleet concierge — open it with `am concierge`' };
    const owner = ownerOf(host, name);
    if (owner) {
      return { error: owner.name === name ? `agent "${name}" already exists — restart it with \`am resume ${name}\`` : `agent name "${name}" is retained as an alias for "${owner.name}"` };
    }
    if (role && !ROLES.some((item) => item.name === role)) return { error: `unknown role "${role}" — list roles with \`am role list\`` };
    const rejected = selectionError(findCatalog(host, provider), model, effort);
    if (rejected) return { error: rejected, selection: true };
    if (dir && !knownDirs().has(dir)) return { error: `directory does not exist: ${dir}` };
    return null;
  }

  const PERMISSION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const promptRoutes: Route[] = [
    {
      method: "GET", path: "/api/agents/:key/permissions", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        if (row instanceof Response) return row;
        const requests = s().permissions.filter((record) => record.row === row && record.state === "pending").map((record) => ({
          id: record.id, provider: record.provider, tool: record.tool, summary: record.summary, input: record.input,
          options: record.options, createdAt: record.createdAt, expiresAt: record.expiresAt,
        }));
        return json({ requests });
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/permissions/:id", handler: withTarget((ctx, target) => {
        const id = ctx.params.id!;
        const optionId = isObject(ctx.body) ? ctx.body.optionId : undefined;
        if (typeof optionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(optionId)) {
          return json({ error: "optionId must be one of the request's option ids" }, 400);
        }
        const notFound = () => json({ error: `no permission request "${id}" for agent "${target.name}"` }, 404);
        if (target.host && !PERMISSION_ID_RE.test(id)) return notFound();
        const row = agentOf(target);
        if (row instanceof Response) return row;
        const record = s().permissions.find((item) => item.id === id && item.row === row);
        if (!record) return notFound();
        if (record.state === "expired") return json({ error: `permission request ${id} expired`, reason: "expired" }, 409);
        if (record.state === "answered") return json({ error: `permission request ${id} is already resolved`, reason: "already_resolved" }, 409);
        if (!record.options.some((option) => option.id === optionId)) {
          return json({ error: `unknown permission option "${optionId}" for request ${id}` }, 400);
        }
        record.state = "answered";
        if (!s().permissions.some((item) => item.row === row && item.state === "pending") && row.status === "needs-attention") {
          delete row.statusReason;
          setStatus(row, "working");
        }
        emit("permission", row, { id, optionId });
        emitStatus(row);
        return json({ ok: true, id, optionId });
      }),
    },
    {
      method: "POST", path: "/api/agents/:key/prompt", handler: withTarget((ctx, target) => {
        const body = ctx.body as { id?: unknown; optionId?: unknown; text?: unknown } | null;
        const valid = !!body && typeof body.id === "string" && /^[a-f0-9]{32}$/.test(body.id)
          && typeof body.optionId === "string" && body.optionId.length <= 64
          && (body.text === undefined || (typeof body.text === "string" && body.text.length <= 2000 && !/[\x00-\x1f\x7f]/.test(body.text)));
        if (!valid) return json({ error: "Invalid prompt answer" }, 400);
        const row = agentOf(target);
        if (row instanceof Response) return row;
        const refuse = (error: string) => json({ ok: false, error }, 409);
        const snapshot = s().prompts.get(row);
        if (!snapshot || snapshot.consumed || snapshot.prompt.id !== body.id) return refuse("Prompt changed or was already answered; refresh and try again");
        const option = snapshot.prompt.options.find((item) => item.id === body.optionId);
        if (!option) return refuse("Invalid prompt option");
        const text = body.text as string | undefined;
        if (option.other) {
          if (typeof text !== "string" || !text.trim() || text.length > 2000 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) {
            return refuse("Other requires a single line of text (maximum 2000 characters)");
          }
        } else if (text !== undefined) return refuse("Text is only supported for Other");
        // Consumed before the keys are sent: a partial write must never be retried.
        snapshot.consumed = true;
        appendEntry(row, { kind: "user", text: option.other ? text! : option.label });
        setStatus(row, "working");
        emit("prompt", row);
        emitStatus(row);
        return json({ ok: true });
      }),
    },
  ];

  const PASTE_TYPES: Record<string, { ext: string; magic: (bytes: Uint8Array) => boolean }> = {
    "image/png": { ext: "png", magic: (b) => b[0] === 0x89 && ascii(b, 1, 4) === "PNG" },
    "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    "image/gif": { ext: "gif", magic: (b) => ascii(b, 0, 4) === "GIF8" },
    "image/webp": { ext: "webp", magic: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  };
  const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  function pastedImage(ctx: Ctx): Response | { ext: string } {
    const type = (ctx.req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const kind = PASTE_TYPES[type];
    if (!kind) return json({ error: "Only PNG, JPEG, GIF and WebP images can be attached" }, 415);
    if (Number(ctx.req.headers.get("content-length") ?? 0) > PASTE_MAX_BYTES) return json({ error: "Image is larger than 10 MB" }, 413);
    const bytes = ctx.bytes ?? new Uint8Array();
    if (bytes.length > PASTE_MAX_BYTES) return json({ error: "Image is larger than 10 MB" }, 413);
    if (!bytes.length) return json({ error: "Image is empty" }, 400);
    if (!kind.magic(bytes)) return json({ error: `File is not a valid ${type} image` }, 415);
    return { ext: kind.ext };
  }
  const workspaceOf = (row: FixtureRow): Workspace => {
    let workspace = s().workspaces.get(row);
    if (!workspace) s().workspaces.set(row, (workspace = seedWorkspace(row)));
    return workspace;
  };

  const fileRoutes: Route[] = [
    {
      method: "POST", path: "/api/agents/:key/files", handler: withTarget((ctx, target) => {
        let row: FixtureRow | Response;
        let image: Response | { ext: string };
        if (target.host) {
          image = pastedImage(ctx);
          if (image instanceof Response) return image;
          row = agentOf(target);
          if (row instanceof Response) return row;
          if (row.provider === "antigravity") return json({ error: "Antigravity image attachments are unsupported" }, 409);
        } else {
          row = agentOf(target);
          if (row instanceof Response) return row;
          if (row.provider === "antigravity") return json({ error: "Antigravity image attachments are unsupported" }, 409);
          image = pastedImage(ctx);
          if (image instanceof Response) return image;
        }
        const count = ++s().uploads;
        const stamp = Date.now();
        const suffix = ((0x5eed0000 + count * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");
        return json({ path: `${FIXTURE_HOME}/.agent-manager/inbox/${row.name}/paste-${stamp}-${suffix}.${image.ext}` }, 201);
      }),
    },
    {
      method: "GET", path: "/api/agents/:key/subagents", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        if (row instanceof Response) return row;
        const live = !STOPPED.has(row.status);
        const records = (s().subagents.get(row) ?? []).map(({ record }) => (live || record.endedAt ? record : { ...record, stale: true }));
        return json({ records });
      }),
    },
    {
      method: "GET", path: "/api/agents/:key/workspace", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        return row instanceof Response ? row : json(workspaceOf(row).info);
      }),
    },
    {
      method: "GET", path: "/api/agents/:key/diff", handler: withTarget((ctx, target) => {
        const path = ctx.url.searchParams.get("path");
        if (!path || path.length > 4096 || path.includes("\0")) return json({ error: "file path required" }, 400);
        const row = agentOf(target, "agent not found");
        if (row instanceof Response) return row;
        const file = workspaceOf(row).diffs.get(path);
        if (!file) return json({ error: "Diff unavailable. The file may have changed, be too large, or be an untracked symlink. Refresh changes and try again." }, 409);
        return json({ path, diff: file.diff, binary: file.binary, truncated: false });
      }),
    },
  ];

  const reportOf = (row: FixtureRow) => agentTokenReport(row, s().histories.get(row), s().subagents.get(row) ?? []);
  const usageRoutes: Route[] = [
    {
      method: "GET", path: "/api/agents/:key/usage", handler: withTarget((_ctx, target) => {
        const row = agentOf(target);
        return row instanceof Response ? row : json(reportOf(row));
      }),
    },
    {
      method: "GET", path: "/api/usage", handler: (ctx) => {
        const params = ctx.url.searchParams;
        const provider = params.get("provider");
        if (provider !== null && !PROVIDERS.includes(provider)) return json({ error: `unknown provider "${provider}"` }, 400);
        const agent = params.get("agent")?.trim() || undefined;
        if (agent !== undefined && !AGENT_NAME_RE.test(agent)) return json({ error: `invalid agent name "${agent}"` }, 400);
        let rows: FixtureRow[];
        // Quirk: any failure here, a missing agent included, is a 404.
        try {
          rows = agent ? [matchLocal(agent)] : hostRows(null).filter((row) => !provider || row.provider === provider);
        } catch (error) {
          return json({ error: (error as Error).message }, 404);
        }
        const now = Date.now();
        const tokens = fleetTokenReport(rows.map(reportOf), now);
        return json({ ...(params.get("quota") !== "0" ? { quota: quota(now) } : {}), tokens });
      },
    },
    {
      method: "GET", path: "/api/usage/summary", handler: (ctx) => {
        const params = ctx.url.searchParams;
        const rawRange = params.get("range") ?? "7";
        const range = Number(rawRange);
        if (!/^\d+$/.test(rawRange) || ![1, 7, 30].includes(range)) return json({ error: `invalid range "${rawRange}" (expected 1, 7, or 30)` }, 400);
        const provider = params.get("provider") || null;
        if (provider !== null && !PROVIDERS.includes(provider)) return json({ error: `unknown provider "${provider}"` }, 400);
        const repo = params.get("repo")?.trim() || undefined;
        const now = Date.now();
        const entries = [
          ...[...s().histories].map(([row, history]) => ({ history: { ...history, name: row.name }, row })),
          ...s().removed.map((history) => ({ history })),
        ];
        const summary = usageSummary(entries, { range: range as 1 | 7 | 30, repo, provider: provider ?? undefined }, now);
        return json({ summary, ...(params.get("quota") !== "0" ? { quota: quota(now) } : {}) });
      },
    },
  ];

  function snippets(entries: TranscriptEntry[], needle: string) {
    const found: { kind: "user" | "assistant" | "tool"; text: string }[] = [];
    for (const entry of entries) {
      const text = entry.kind === "tool" ? `${entry.name} ${entry.input}\n${entry.output}` : entry.text;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 80);
      const end = Math.min(text.length, at + needle.length + 160);
      found.push({ kind: entry.kind, text: `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}` });
      if (found.length === 3) break;
    }
    return found;
  }
  const searchRoutes: Route[] = [
    {
      method: "POST", path: "/api/search", handler: (ctx) => {
        const query = isObject(ctx.body) ? ctx.body.query : undefined;
        if (typeof query !== "string" || query.trim().length < 2 || query.length > 256 || query.includes("\0")) {
          return json({ error: "Search must contain 2–256 characters" }, 400);
        }
        const needle = query.trim().toLowerCase();
        const matches = [];
        // Local agents first, then each reachable remote; an unreachable one makes the result partial.
        for (const host of [null, ...FIXTURE_REMOTE_HOSTS.filter((item) => item.reachable).map((item) => item.name)]) {
          for (const row of hostRows(host).slice(0, 100)) {
            const found = snippets(s().transcripts.get(row) ?? [], needle);
            if (found.length) matches.push({ name: row.name, ...(host ? { host } : {}), snippets: found });
          }
        }
        return json({ matches, partial: UNREACHABLE.length > 0, unavailable: UNREACHABLE });
      },
    },
  ];

  // drift-net flips between working and idle so live updates are visible.
  function flipDrift() {
    const row = hostRows(null).find((candidate) => candidate.name === DRIFTING_AGENT);
    if (!row || s().delivering.has(row) || (row.status !== "working" && row.status !== "idle")) return;
    setStatus(row, row.status === "working" ? "idle" : "working");
    fx.broadcast("fleet", { type: "status", agent: row.name, status: row.status, at: row.updatedAt });
    drain(row);
  }

  return {
    routes: [...readRoutes, ...lifecycleRoutes, ...manageRoutes, ...agentSetupRoutes, ...promptRoutes, ...fileRoutes, ...usageRoutes, ...searchRoutes],
    flipDrift,
  };
}
