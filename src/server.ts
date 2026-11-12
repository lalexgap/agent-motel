import { agentPanePrompt, answerPanePrompt, validPromptAnswer } from "./webPrompts";
import { runConversationSearch, validSearchQuery, type ConversationMatches } from "./webSearch";
import { recordAudit, withAuditContext } from "./audit";
import { agentRuntimeSettings } from "./runtimeSettings";
import { moveAgent } from "./commands/move";
import { handoffAgent } from "./commands/handoff";
import { agentWorkspaceDiff, agentWorkspace, validateRemoteWorkspace, cachedWorkspace, withPullRequests, type WorkspaceInfo } from "./workspace";
import { createWebAuth, secureWebResponse } from "./webAuth";
import { createWebTerminal, terminalTarget, remoteTerminalTarget, type TerminalData } from "./webTerminal";
import { startWebEvents } from "./webEvents";
import { ensureConcierge, resolveConciergeHostAsync } from "./commands/concierge";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiTokenFile, ensureDirs, inboxDir } from "./paths";
import { type Provider, isProvider, agentNamesAndAliases, agentProvider, readAgent, resolveAgent } from "./state";
import { cachedFleetRows } from "./fleet";
import { agentPresence, displayStatus, waitingInfo } from "./commands/ls";
import { buildFleetSummary } from "./summary";
import { gcSummaryLine } from "./autoGc";
import { queueList } from "./queue";
import { capturePane, hasSession } from "./tmux";
import { sendCommand, interruptCommand, abortTurn } from "./commands/send";
import { readSubagents, reconcileOpenSubagents } from "./subagents";
import { jsonRecords } from "./commands/subagents";
import { collectUsage, type ProviderUsage } from "./usage";
import { collectAgentTokenUsage, collectFleetTokenUsage, enrichSubagentsWithTokens } from "./tokenUsage";
import { ledgerAgeMs, readUsageLedger, refreshUsageLedger, SUMMARY_RANGES, usageSummary, type SummaryRange } from "./usageLedger";
import { transcriptJson, subagentTranscriptJson } from "./commands/transcript";
import { newCommand } from "./commands/new";
import { stopAgent, destroyAgent } from "./commands/rm";
import { reviveAgent } from "./commands/resume";
import { restartAgent, restartExactAgent, type RestartPrecondition } from "./commands/restart";
import { localCatalogs } from "./commands/models";
import { parseCatalogs, SelectionError, type ProviderCatalog } from "./catalog";
import { renameAgent } from "./commands/rename";
import { daemonRequest, notifyDaemon } from "./daemon";
import { cancelMessage, type CancelResult } from "./deliver";
import { alreadyReason, conflictReason, isMessageId, type Conflict, type ConflictReason } from "./messages";
import { listRoles, roleForAgent } from "./roles";
import {
  OPTION_ID_RE,
  PermissionOptionError,
  answerPermission,
  isPermissionId,
  pendingPermissions,
  publicPermission,
  type AnswerResult,
} from "./permissions";
import { loadConfig, localHostIdentity } from "./config";
import {
  AGENT_NAME_RE,
  HOST_RE,
  REMOTE_NEW_TIMEOUT_MS,
  RemoteError,
  ensureExactCapable,
  pushRemoteInboxFile,
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
  const presence = agentPresence(agent);
  const status = presence.status;
  const nativeControls = agentProvider(agent) !== "antigravity";
  return {
    name: agent.name,
    status,
    // The stored status: `status` is how the agent is shown (an idle agent
    // with live subagents is working), this is what delivery acts on.
    rawStatus: presence.rawStatus,
    busyWith: presence.busyWith ?? null,
    statusReason: status === "waiting"
      ? waitingInfo(agent).detail ?? null
      : status === "dead"
        ? "tmux session is missing"
        : presence.reason ?? null,
    statusChangedAt: agent.statusChangedAt ?? agent.updatedAt,
    provider: agentProvider(agent),
    capabilities: {
      remoteControl: nativeControls, quota: nativeControls,
      approvalRelay: nativeControls, interruptByReceipt: nativeControls,
      handoff: nativeControls, move: nativeControls, rename: nativeControls,
      subagents: nativeControls, attachments: nativeControls,
    },
    // null = the provider default.
    runtime: agentRuntimeSettings(agent),
    model: agent.model ?? null,
    effort: agent.effort ?? null,
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
    // Tells a serve on another host that this am returns ids from send --json.
    messageReceipts: true,
    terminalAttach: 1,
    panePrompt: agentProvider(agent) === "claude" ? agentPanePrompt(name) : null,
    permissionRequests: nativeControls,
    interruptByReceipt: nativeControls,
    pendingPermissions: pendingPermissions(agentNamesAndAliases(agent)).length,
  };
}

// --- permission requests ---------------------------------------------------

export function agentPermissions(name: string): { requests: ReturnType<typeof publicPermission>[] } | null {
  const agent = readAgent(name);
  if (!agent) return null;
  return { requests: pendingPermissions(agentNamesAndAliases(agent)).map(publicPermission) };
}

// Answer for a local agent. Null: no such agent or request.
export async function answerAgentPermission(name: string, id: string, optionId: string): Promise<AnswerResult | null> {
  const agent = readAgent(name);
  if (!agent || !isPermissionId(id)) return null;
  const result = await answerPermission(agentNamesAndAliases(agent), id, optionId);
  if (result) await notifyDaemon(agent.name, "permission-resolved");
  return result;
}

function permissionNotFound(name: string, id: string): Response {
  return json({ error: `no permission request "${id}" for agent "${name}"` }, 404);
}

function permissionResponse(result: AnswerResult): Response {
  return result.ok ? json(result) : json({ error: result.error, reason: result.reason }, 409);
}

async function permissionAnswerBody(req: Request): Promise<Response | { optionId: string }> {
  const body = (await req.json().catch(() => null)) as { optionId?: unknown } | null;
  if (typeof body?.optionId !== "string" || !OPTION_ID_RE.test(body.optionId)) {
    return json({ error: "optionId must be one of the request's option ids" }, 400);
  }
  return { optionId: body.optionId };
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

// `fallback`: the reason a message or interrupt route gives a 409 whose
// cause the remote am did not say.
function remoteFailure(error: unknown, fallback?: "unknown"): Response {
  if (error instanceof RemoteError) {
    const reason = error.status === 409 ? (error.reason ?? fallback) : undefined;
    return json(reason ? { error: error.message, reason } : { error: error.message }, error.status);
  }
  return json({ error: (error as Error).message }, 502);
}

function conflict(error: string, reason: ConflictReason, state?: string): Response {
  return json(state === undefined ? { error, reason } : { error, state, reason }, 409);
}

// A refusal thrown by a send or an interrupt.
function thrownConflict(error: unknown): Response {
  const message = (error as Error).message;
  return conflict(message, conflictReason(message) ?? "unknown");
}

// A remote am from before reasons returns a refusal without one.
function resultReason(result: Conflict): ConflictReason {
  return result.reason ?? conflictReason(result.error) ?? (result.state === "queued" ? "unknown" : alreadyReason(result.state));
}

interface TranscriptShape {
  entries: { index: number }[];
}

function messageNotFound(name: string, id: string): Response {
  return json({ error: `no message "${id}" for agent "${name}"` }, 404);
}

function cancelResponse(result: CancelResult): Response {
  return result.ok ? json(result) : conflict(result.error, resultReason(result), result.state);
}

// Conditional stops and restarts are CLI-only (`am stop --if-idle`); refuse
// a client that still sends those fields rather than act unconditionally.
async function refuseFields(req: Request, fields: string[]): Promise<Response | null> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const sent = body && typeof body === "object" ? fields.find((field) => Object.hasOwn(body, field)) : undefined;
  return sent ? json({ error: `${sent} is not supported${sent === "ifIdle" ? "; use `am stop --if-idle`" : ""}` }, 400) : null;
}
const stopBody = (req: Request) => refuseFields(req, ["ifIdle"]);
const restartBody = (req: Request) => refuseFields(req, ["ifIdle", "model", "effort"]);

export interface ModelSelectionBody {
  model: string | null;
  effort?: string | null;
  createdAt: string;
  status: string;
}

export function parseModelSelectionBody(value: unknown): ModelSelectionBody | Response {
  const body = value as Record<string, unknown> | null;
  if (!body || Array.isArray(body) || typeof body !== "object") return json({ error: "JSON object required" }, 400);
  const fields = Object.keys(body);
  const extra = fields.find(field => !["model", "effort", "createdAt", "status"].includes(field));
  if (extra) return json({ error: `${extra} is not supported` }, 400);
  if (!Object.hasOwn(body, "model")) return json({ error: "model is required" }, 400);
  if (typeof body.createdAt !== "string" || !body.createdAt || body.createdAt.length > 128 || /[\x00-\x1f\x7f]/.test(body.createdAt)) {
    return json({ error: "createdAt is required" }, 400);
  }
  if (typeof body.status !== "string" || !["starting", "idle", "waiting", "working", "needs-attention"].includes(body.status)) {
    return json({ error: "status must identify a running agent" }, 400);
  }
  for (const [field, limit] of [["model", 256], ["effort", 64]] as const) {
    if (!Object.hasOwn(body, field)) continue;
    const value = body[field];
    if (value !== null && typeof value !== "string") return json({ error: `${field} must be a string or null` }, 400);
    if (typeof value === "string" && (!value.length || value.length > limit || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-"))) {
      return json({ error: `${field} is invalid` }, 400);
    }
  }
  return body as ModelSelectionBody;
}

async function modelSelectionBody(req: Request): Promise<ModelSelectionBody | Response> {
  return parseModelSelectionBody(await req.json().catch(() => null));
}

export function modelSelectionPrecondition(body: ModelSelectionBody): RestartPrecondition {
  return { createdAt: body.createdAt, status: body.status };
}

// --- models ------------------------------------------------------------------

const MODELS_TTL_MS = 10 * 60_000;
const modelsCache = new Map<string, { at: number; catalogs: ProviderCatalog[] }>();
const QUOTA_TTL_MS = 30_000;
let quotaCache: { at: number; data: ProviderUsage[] } | null = null;

export function resetModelsCacheForTests(): void {
  modelsCache.clear();
  quotaCache = null;
}

async function cachedQuotaUsage(refresh: boolean): Promise<ProviderUsage[]> {
  if (!refresh && quotaCache && Date.now() - quotaCache.at < QUOTA_TTL_MS) {
    return quotaCache.data;
  }
  const report = await collectUsage();
  quotaCache = { at: Date.now(), data: report.providers };
  return report.providers;
}

const USAGE_LEDGER_STALE_MS = 60_000;

export async function usageSummaryResponse(params: URLSearchParams): Promise<Response> {
  const rawRange = params.get("range") ?? "7";
  const range = Number(rawRange) as SummaryRange;
  if (!/^\d+$/.test(rawRange) || !SUMMARY_RANGES.includes(range)) {
    return json({ error: `invalid range "${rawRange}" (expected 1, 7, or 30)` }, 400);
  }
  const rawProvider = params.get("provider") || null;
  if (rawProvider !== null && !isProvider(rawProvider)) {
    return json({ error: `unknown provider "${rawProvider}"` }, 400);
  }
  const repo = params.get("repo")?.trim() || undefined;
  const refresh = params.get("refresh") === "1";
  try {
    if (refresh || ledgerAgeMs(readUsageLedger()) > USAGE_LEDGER_STALE_MS) {
      refreshUsageLedger({ budgetMs: 1500 });
    }
    const summary = usageSummary({ range, repo, provider: rawProvider ?? undefined });
    const quota = params.get("quota") !== "0" ? await cachedQuotaUsage(refresh) : undefined;
    return json({ summary, ...(quota ? { quota } : {}) });
  } catch (error) {
    return json({ error: (error as Error).message }, 500);
  }
}

// `am models --json` here or on a fleet host, cached per host.
async function hostCatalogs(host: string | null, refresh: boolean): Promise<ProviderCatalog[]> {
  const key = host ?? "";
  const cached = modelsCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.catalogs;
  const catalogs = host
    ? parseCatalogs(await runRemoteAm(host, ["models", "--json"], { timeoutMs: 15_000 }))
    : localCatalogs({ refresh: true });
  modelsCache.set(key, { at: Date.now(), catalogs });
  return catalogs;
}

// {text?}: an error response, or the text to send after the Esc.
async function interruptBody(req: Request): Promise<Response | string> {
  const body = (await req.json().catch(() => null)) as { text?: unknown; messageId?: unknown } | null;
  if (body && typeof body === "object" && Object.hasOwn(body, "messageId")) return json({ error: "messageId is not supported" }, 400);
  if (body?.text != null && typeof body.text !== "string") return json({ error: "text must be a string" }, 400);
  return typeof body?.text === "string" ? body.text.trim() : "";
}

async function handoffBody(req: Request): Promise<{ to: "claude" | "codex"; newName?: string; full: boolean } | Response> {
  const body = await req.json().catch(() => null) as { to?: unknown; newName?: unknown; full?: unknown } | null;
  if (body?.to === "antigravity") return json({ error: "antigravity handoff is unsupported" }, 400);
  if (!body || (body.to !== "claude" && body.to !== "codex")) return json({ error: "to must be claude or codex" }, 400);
  if (body.newName !== undefined && (typeof body.newName !== "string" || !AGENT_NAME_RE.test(body.newName) || body.newName.length > 64))
    return json({ error: "newName must be 1–64 letters, numbers, dashes or underscores" }, 400);
  if (body.full !== undefined && typeof body.full !== "boolean") return json({ error: "full must be a boolean" }, 400);
  return { to: body.to, newName: body.newName, full: body.full ?? false };
}

export const PASTE_MAX_BYTES = 10 * 1024 * 1024;
const JSON_MAX_BYTES = 256 * 1024;
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const PASTE_TYPES: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b[0] === 0x89 && ascii(b, 1, 4) === "PNG" },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { ext: "gif", magic: (b) => ascii(b, 0, 4) === "GIF8" },
  "image/webp": { ext: "webp", magic: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
};

async function pastedImage(req: Request): Promise<Response | { bytes: Uint8Array; fileName: string }> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const kind = PASTE_TYPES[type];
  if (!kind) return json({ error: "Only PNG, JPEG, GIF and WebP images can be attached" }, 415);
  if (Number(req.headers.get("content-length") ?? 0) > PASTE_MAX_BYTES) return json({ error: "Image is larger than 10 MB" }, 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > PASTE_MAX_BYTES) return json({ error: "Image is larger than 10 MB" }, 413);
  if (!bytes.length) return json({ error: "Image is empty" }, 400);
  if (!kind.magic(bytes)) return json({ error: `File is not a valid ${type} image` }, 415);
  return { bytes, fileName: `paste-${Date.now()}-${randomBytes(4).toString("hex")}.${kind.ext}` };
}

function saveLocalPaste(name: string, fileName: string, bytes: Uint8Array): string {
  const dir = inboxDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, fileName);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}

async function handleRemoteAgent(req: Request, host: string, name: string, rest: string[]): Promise<Response> {
  const method = req.method;


  const route = rest[0];
  const fallback = route === "messages" || route === "interrupt" ? "unknown" : undefined;
  try {
    // __cancel ships after --exact and reads the name exactly, and an am
    // without it fails "unknown command", so it needs no __detail precheck.
    if (route === "messages" && rest.length === 2 && method === "DELETE") {
      const id = rest[1]!;
      if (!isMessageId(id)) return messageNotFound(name, id);
      return cancelResponse(await runRemoteJson<CancelResult>(host, ["__cancel", name, id], { timeoutMs: 30_000 }));
    }
    // Like __cancel: __permissions/__permission ship after --exact, and an
    // older am fails "unknown command".
    if (route === "permissions" && rest.length === 1 && method === "GET") {
      return json(await runRemoteJson(host, ["__permissions", name]));
    }
    if (route === "permissions" && rest.length === 2 && method === "POST") {
      const id = rest[1]!;
      const body = await permissionAnswerBody(req);
      if (body instanceof Response) return body;
      if (!isPermissionId(id)) return permissionNotFound(name, id);
      return permissionResponse(await runRemoteJson<AnswerResult>(host, ["__permission", name, id, body.optionId], { timeoutMs: 30_000 }));
    }
    if (route === "prompt" && rest.length === 1 && method === "POST") {
      const body = await req.json().catch(() => null);
      if (!validPromptAnswer(body)) return json({ error: "Invalid prompt answer" }, 400);
      const result = await runRemoteJson<{ ok: boolean; error?: string }>(host, ["__prompt-answer", name], { stdin: JSON.stringify(body) });
      return json(result, result.ok ? 200 : 409);
    }
    if (rest.length > 1) return json({ error: "not found" }, 404);
    if (!route && method === "GET") return json(await runRemoteJson(host, ["__detail", name]));
    if (route === "workspace" && method === "GET") {
      return json(await cachedWorkspace(`remote:${host}:${name}`, async () => withPullRequests(validateRemoteWorkspace(await runRemoteJson(host, ["__workspace", name])))));
    }
    if (route === "diff" && method === "GET") {
      const path = new URL(req.url).searchParams.get("path");
      if (!path || path.length > 4096 || path.includes("\0")) return json({ error: "file path required" }, 400);
      const result = await runRemoteJson(host, ["__workspace-diff", name], { stdin: JSON.stringify(path) });
      return json(result);
    }
    if (route === "files" && method === "POST") {
      const image = await pastedImage(req);
      if (image instanceof Response) return image;
      return json({ path: await pushRemoteInboxFile(host, name, image.fileName, image.bytes) }, 201);
    }
    if (route === "subagents" && method === "GET") {
      await ensureExactCapable(host, name);
      return json({ records: await runRemoteJson(host, ["subagents", name, "--json"]) });
    }
    if (route === "usage" && method === "GET") {
      await ensureExactCapable(host, name);
      return json(await runRemoteJson(host, ["usage", name, "--tokens", "--json"]));
    }
    if (route === "handoff" && method === "POST") {
      const body = await handoffBody(req);
      if (body instanceof Response) return body;
      const args = ["__handoff", name, "--to", body.to];
      if (body.newName) args.push("--new-name", body.newName);
      if (body.full) args.push("--full");
      const result = await runRemoteJson<{ name: string; target: Provider }>(host, args, { timeoutMs: REMOTE_NEW_TIMEOUT_MS });
      if (typeof result?.name !== "string" || !AGENT_NAME_RE.test(result.name) || result.target !== body.to)
        return json({ error: "Unexpected handover response. Check the agent list before retrying." }, 502);
      return json({ ok: true, name: result.name, target: result.target, key: `${host}:${result.name}` }, 201);
    }
    if (route === "rename" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
      if (typeof body?.name !== "string" || !AGENT_NAME_RE.test(body.name) || body.name.length > 64)
        return json({ error: "Use a name of 1–64 letters, numbers, dashes or underscores" }, 400);
      await ensureExactCapable(host, name);
      await runRemoteAm(host, ["rename", name, body.name]);
      return json({ ok: true, name: body.name, key: `${host}:${body.name}` });
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
      // The __detail precheck doubles as the receipts capability check: an
      // older am would take --json as noise, send, and print no id.
      const detail = await runRemoteJson<{ messageReceipts?: boolean }>(host, ["__detail", name]);
      if (detail?.messageReceipts !== true) {
        return conflict(`remote am too old on ${host} (no message receipts)`, "remote_too_old");
      }
      const args = mode === "interrupt"
        ? ["interrupt", name, "-", "--json"]
        : ["send", name, "-", "--json", ...(mode === "now" ? ["--now"] : [])];
      const sent = await runRemoteJson<{ id?: unknown }>(host, args, { stdin: text });
      if (typeof sent?.id !== "string") return json({ error: `am send on ${host} returned no message id` }, 502);
      return json({ ok: true, mode, id: sent.id });
    }

    if (route === "transcript" && method === "GET") {
      await ensureExactCapable(host, name);
      const subagent = new URL(req.url).searchParams.get("subagent");
      if (subagent !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(subagent)) return json({ error: "invalid subagent id" }, 400);
      const transcript = await runRemoteJson<TranscriptShape>(host, ["transcript", name, "--json", ...(subagent ? ["--subagent", subagent] : [])], { timeoutMs: 30_000 });
      if (!Array.isArray(transcript?.entries)) {
        return json({ error: `remote am too old on ${host} (transcript --json has no entries)` }, 409);
      }
      return json(transcript);
    }

    if (route === "interrupt" && method === "POST") {
      const text = await interruptBody(req);
      if (text instanceof Response) return text;
      if (text) await run(["interrupt", name, "-"], { stdin: text });
      else await run(["interrupt", name]);
      return json({ ok: true });
    }

    if (route === "stop" && method === "POST") {
      const refused = await stopBody(req);
      if (refused) return refused;
      await run(["stop", name]);
      return json({ ok: true });
    }

    if (route === "resume" && method === "POST") {
      await run(["resume", name]);
      return json({ ok: true });
    }

    if (route === "restart" && method === "POST") {
      const refused = await restartBody(req);
      if (refused) return refused;
      await run(["restart", name]);
      return json({ ok: true });
    }

    if (route === "model" && method === "POST") {
      const body = await modelSelectionBody(req);
      if (body instanceof Response) return body;
      await runRemoteAm(host, ["__restart-model", name], { stdin: JSON.stringify(body) });
      return json({ ok: true, model: body.model, ...(body.effort !== undefined ? { effort: body.effort } : {}) });
    }
  } catch (error) {
    return remoteFailure(error, fallback);
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
  if (body.provider !== undefined && !isProvider(body.provider)) return json({ error: "unknown provider" }, 400);
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

let activeSearches = 0;

// Only route templates enter the audit context; never request URLs or IDs.
function auditRoute(req: Request, parts: string[]): string {
  const actions = new Set(["stop", "restart", "model", "resume", "move", "handoff", "rename", "messages", "permissions", "prompt", "interrupt", "files", "transcript", "workspace", "diff", "subagents", "usage"]);
  const route = parts[0] === "agents" && parts.length >= 2
    ? `agents/:name${parts[2] && actions.has(parts[2]) ? `/${parts[2]}${parts.length > 3 ? "/:id" : ""}` : parts.length > 2 ? "/:action" : ""}`
    : "api";
  return `${["GET", "HEAD", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"].includes(req.method) ? req.method : "OTHER"} ${route}`;
}

async function auditedApi(req: Request, parts: string[]): Promise<Response> {
  const stopping = req.method === "POST" && parts.length === 3 && parts[0] === "agents" && parts[2] === "stop";
  const target = stopping ? parseTarget(parts[1]!) : undefined;
  if (!target || target instanceof Response) return handleApi(req, parts);
  const details = target.host ? { targetHost: target.host } : {};
  const requestId = recordAudit(target.name, "stop-request", "requested", details);
  try {
    const response = await handleApi(req, parts);
    let reason: string | undefined;
    if (!response.ok) {
      const body = await response.clone().json().catch(() => null) as { reason?: unknown } | null;
      const safeReasons = ["remote_too_old", "not_found"];
      reason = typeof body?.reason === "string" && safeReasons.includes(body.reason) ? body.reason : `http_${response.status}`;
    }
    recordAudit(target.name, "stop-request", response.ok ? "completed" : response.status < 500 ? "refused" : "failed", { ...details, requestId, ...(reason ? { reason } : {}) });
    return response;
  } catch (error) {
    recordAudit(target.name, "stop-request", "failed", { ...details, requestId, reason: "http_exception" });
    throw error;
  }
}

async function handleApi(req: Request, parts: string[]): Promise<Response> {
  const method = req.method;
  if (parts.length === 1 && parts[0] === "search" && method === "POST") {
    const body = (await req.json().catch(() => null)) as { query?: unknown } | null;
    const query = body?.query;
    if (!validSearchQuery(query)) return json({ error: "Search must contain 2–256 characters" }, 400);
    if (activeSearches >= 2) return json({ error: "Search is busy. Try again shortly." }, 429);
    activeSearches++;
    try {
      const errors: string[] = [];
      const local = runConversationSearch(query);
      const remotes = await Promise.all((loadConfig().remotes || []).map(async host => {
        try {
          const result = await runRemoteJson<ConversationMatches>(host, ["__web-search"], { stdin: JSON.stringify(query), timeoutMs: 10000 });
          if (!Array.isArray(result.matches) || result.matches.length > 100) throw new Error("Invalid search response");
          return { partial: !!result.partial, matches: result.matches.filter(match =>
            typeof match.name === "string" && AGENT_NAME_RE.test(match.name) && Array.isArray(match.snippets)
          ).map(match => ({ name: match.name, host, snippets: match.snippets.slice(0, 3).filter(snippet =>
            ["user", "assistant", "tool"].includes(snippet.kind) && typeof snippet.text === "string"
          ).map(snippet => ({ kind: snippet.kind, text: snippet.text.slice(0, 600) })) })) };
        } catch { errors.push(host); return { matches: [], partial: true }; }
      }));
      const all = [await local, ...remotes];
      return json({ matches: all.flatMap(result => result.matches), partial: all.some(result => result.partial), unavailable: errors });
    } finally { activeSearches--; }
  }
  if (parts.length === 1 && parts[0] === "concierge" && method === "GET") {
    const host = await resolveConciergeHostAsync();
    return json({ key: host ? `${host}:concierge` : "concierge" });
  }
  if (parts.length === 1 && parts[0] === "concierge" && method === "POST") {
    try { const location = await ensureConcierge(undefined, { quiet: true }); return json({ key: location.key }); }
    catch (error) { return json({ error: (error as Error).message }, 409); }
  }

  // GET /api/health
  if (parts.length === 1 && parts[0] === "health" && method === "GET") {
    return json({ ok: true, name: "am" });
  }

  // GET /api/models[?host=h][&refresh=1] — `am models --json` for this
  // machine or a fleet host, cached ~10 minutes per host.
  if (parts.length === 1 && parts[0] === "models" && method === "GET") {
    const params = new URL(req.url).searchParams;
    const raw = params.get("host");
    let host: string | null = null;
    if (raw) {
      if (!HOST_RE.test(raw)) return json({ error: `invalid host "${raw}"` }, 400);
      const resolved = resolveHost(raw);
      if (resolved === undefined) return json({ error: `unknown host "${raw}" (not in config.remotes)` }, 404);
      host = resolved;
    }
    try {
      return json(await hostCatalogs(host, params.get("refresh") === "1"));
    } catch (error) {
      return remoteFailure(error);
    }
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
    return json(buildFleetSummary(cachedFleetRows(), new Date(), gcSummaryLine()));
  }

  // GET /api/usage/summary?range=1|7|30[&repo=][&provider=][&quota=0][&refresh=1]
  // — the stored usage ledger, refreshed by one bounded slice when stale.
  if (parts.length === 2 && parts[0] === "usage" && parts[1] === "summary" && method === "GET") {
    return usageSummaryResponse(new URL(req.url).searchParams);
  }

  // GET /api/usage[?provider=claude|codex][&agent=name][&refresh=1][&quota=0]
  if (parts.length === 1 && parts[0] === "usage" && method === "GET") {
    const params = new URL(req.url).searchParams;
    const rawProvider = params.get("provider");
    if (rawProvider !== null && !isProvider(rawProvider)) {
      return json({ error: `unknown provider "${rawProvider}"` }, 400);
    }
    const agentName = params.get("agent")?.trim() || undefined;
    if (agentName !== undefined && !AGENT_NAME_RE.test(agentName)) {
      return json({ error: `invalid agent name "${agentName}"` }, 400);
    }
    try {
      const includeQuota = params.get("quota") !== "0";
      const refresh = params.get("refresh") === "1";
      const [quota, tokens] = await Promise.all([
        includeQuota ? cachedQuotaUsage(refresh) : Promise.resolve(undefined),
        Promise.resolve(
          collectFleetTokenUsage({
            provider: (rawProvider as Provider | null) ?? undefined,
            agentName,
          }),
        ),
      ]);
      return json({ ...(quota ? { quota } : {}), tokens });
    } catch (error) {
      return json({ error: (error as Error).message }, 404);
    }
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
    if (body.provider !== undefined && !isProvider(body.provider)) {
      return json({ error: "provider must be claude, codex, or antigravity" }, 400);
    }
    if (body.codex !== undefined && typeof body.codex !== "boolean") return json({ error: "codex must be a boolean" }, 400);
    if (body.provider !== undefined && body.codex !== undefined && ((body.provider === "codex") !== body.codex)) {
      return json({ error: "contradictory provider and codex selection" }, 400);
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
        remote: body.provider === "antigravity" ? false : undefined,
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
    if (parts.length === 3 && parts[2] === "move" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { host?: unknown; dir?: unknown } | null;
      if (typeof body?.host !== "string" || !HOST_RE.test(body.host)) return json({ error: "destination host required" }, 400);
      const destination = resolveHost(body.host);
      if (destination === undefined) return json({ error: "unknown destination host" }, 404);
      if (destination === target.host || (destination && target.host)) return json({ error: "Move between this server and one configured remote host" }, 400);
      if (body.dir !== undefined && (typeof body.dir !== "string" || !body.dir.startsWith("/") || body.dir.includes("\0")))
        return json({ error: "destination directory must be an absolute path" }, 400);
      if (!target.host && !readAgent(target.name)) return json({ error: "agent not found" }, 404);
      try {
        if (target.host) await ensureExactCapable(target.host, target.name);
        const message = await moveAgent(target.host ? `${target.host}:${target.name}` : target.name, destination || undefined,
          { copy: false, start: true, exact: true, ...(body.dir ? { dir: body.dir } : {}) });
        return json({ ok: true, key: destination ? `${destination}:${target.name}` : target.name, message });
      } catch (error) { return json({ error: (error as Error).message }, 409); }
    }
    if (target.host) return handleRemoteAgent(req, target.host, target.name, parts.slice(2));
    const { name } = target;

    // GET /api/agents/:name — detail + queue + pane snapshot (local agents)
    if (parts.length === 2 && method === "GET") {
      const detail = agentDetail(name);
      return detail ? json(detail) : json({ error: `no local agent "${name}"` }, 404);
    }

    if (parts.length === 3 && parts[2] === "diff" && method === "GET") {
      const path = new URL(req.url).searchParams.get("path");
      if (!path || path.length > 4096 || path.includes("\0")) return json({ error: "file path required" }, 400);
      if (!readAgent(name)) return json({ error: "agent not found" }, 404);
      try { return json(await agentWorkspaceDiff(name, path)); }
      catch { return json({ error: "Diff unavailable. The file may have changed, be too large, or be an untracked symlink. Refresh changes and try again." }, 409); }
    }
    if (parts.length === 3 && parts[2] === "workspace" && method === "GET") {
      if (!readAgent(name)) return json({ error: `no local agent "${name}"` }, 404);
      try { return json(await agentWorkspace(name)); }
      catch { return json({ error: "Workspace inspection unavailable. Try again shortly." }, 503); }
    }

    // POST /api/agents/:name/files — raw image body; returns {path} in the inbox
    if (parts.length === 3 && parts[2] === "files" && method === "POST") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      if (agentProvider(agent) === "antigravity") return json({ error: "Antigravity image attachments are unsupported" }, 409);
      const image = await pastedImage(req);
      if (image instanceof Response) return image;
      return json({ path: saveLocalPaste(name, image.fileName, image.bytes) }, 201);
    }

    if (parts.length === 3 && parts[2] === "handoff" && method === "POST") {
      const body = await handoffBody(req);
      if (body instanceof Response) return body;
      const source = readAgent(name);
      if (!source) return json({ error: `no local agent "${name}"` }, 404);
      if (agentProvider(source) === "antigravity") return json({ error: "antigravity handoff is unsupported" }, 409);
      try {
        const result = await handoffAgent(name, { ...body, exact: true, jump: false, quiet: true });
        return json({ ok: true, name: result.name, target: result.target, key: result.name }, 201);
      } catch (error) { return json({ error: (error as Error).message }, 409); }
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
      if (!readAgent(name)) return json({ error: `no local agent "${name}"` }, 404);
      try {
        const { id } = mode === "interrupt"
          ? await interruptCommand(name, text, { exact: true, track: true })
          : await sendCommand(name, text, { now: mode === "now", track: true });
        if (!id) return conflict(`message to "${name}" was not sent`, "not_delivered");
        return json({ ok: true, mode, id });
      } catch (error) {
        return thrownConflict(error);
      }
    }

    // DELETE /api/agents/:name/messages/:id — cancel while still queued
    if (parts.length === 4 && parts[2] === "messages" && method === "DELETE") {
      const id = parts[3]!;
      if (!readAgent(name)) return json({ error: `no local agent "${name}"` }, 404);
      const result = await cancelMessage(name, id);
      return result ? cancelResponse(result) : messageNotFound(name, id);
    }

    if (parts.length === 3 && parts[2] === "prompt" && method === "POST") {
      const body = await req.json().catch(() => null);
      if (!validPromptAnswer(body)) return json({ error: "Invalid prompt answer" }, 400);
      if (!readAgent(name)) return json({ error: `no local agent "${name}"` }, 404);
      const result = answerPanePrompt(name, body);
      return json(result, result.ok ? 200 : 409);
    }

    // GET /api/agents/:name/permissions — prompts waiting on an answer
    if (parts.length === 3 && parts[2] === "permissions" && method === "GET") {
      const permissions = agentPermissions(name);
      return permissions ? json(permissions) : json({ error: `no local agent "${name}"` }, 404);
    }

    // POST /api/agents/:name/permissions/:id — {optionId}: answer with one
    // of the request's own options
    if (parts.length === 4 && parts[2] === "permissions" && method === "POST") {
      const id = parts[3]!;
      const body = await permissionAnswerBody(req);
      if (body instanceof Response) return body;
      if (!readAgent(name)) return json({ error: `no local agent "${name}"` }, 404);
      try {
        const result = await answerAgentPermission(name, id, body.optionId);
        return result ? permissionResponse(result) : permissionNotFound(name, id);
      } catch (error) {
        if (error instanceof PermissionOptionError) return json({ error: error.message }, 400);
        throw error;
      }
    }

    if (parts.length === 3 && parts[2] === "subagents" && method === "GET") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      const status = displayStatus(agent);
      const live = status !== "dead" && status !== "exited";
      if (live) reconcileOpenSubagents(agent);
      const records = enrichSubagentsWithTokens(agent, readSubagents(name));
      return json({ records: jsonRecords(records, live) });
    }

    if (parts.length === 3 && parts[2] === "usage" && method === "GET") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      return json(collectAgentTokenUsage(agent));
    }

    // GET /api/agents/:name/transcript[?subagent=id] — see transcriptJson
    if (parts.length === 3 && parts[2] === "transcript" && method === "GET") {
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      const subagent = new URL(req.url).searchParams.get("subagent");
      if (subagent !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(subagent)) return json({ error: "invalid subagent id" }, 400);
      try { return json(subagent ? subagentTranscriptJson(agent, subagent) : transcriptJson(agent)); }
      catch (error) { return json({ error: (error as Error).message }, 409); }
    }

    // POST /api/agents/:name/interrupt — {text?}: Esc, then send text if given
    if (parts.length === 3 && parts[2] === "interrupt" && method === "POST") {
      const text = await interruptBody(req);
      if (text instanceof Response) return text;
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      try {
        if (text) await interruptCommand(agent.name, text, { exact: true });
        else await abortTurn(agent.name);
        return json({ ok: true });
      } catch (error) {
        return thrownConflict(error);
      }
    }

    // POST /api/agents/:name/rename — {name}
    if (parts.length === 3 && parts[2] === "rename" && method === "POST") {
      const body = (await req.json().catch(() => null)) as { name?: string } | null;
      if (typeof body?.name !== "string" || !AGENT_NAME_RE.test(body.name) || body.name.length > 64) return json({ error: "valid name required (1–64 characters)" }, 400);
      if (!readAgent(name)) return json({ error: "agent not found" }, 404);
      try {
        const result = await renameAgent(name, body.name);
        return json({ ok: true, oldName: result.oldName, name: result.newName, live: result.live });
      } catch (error) {
        return json({ error: (error as Error).message }, 409);
      }
    }

    // POST /api/agents/:name/stop
    if (parts.length === 3 && parts[2] === "stop" && method === "POST") {
      const refused = await stopBody(req);
      if (refused) return refused;
      try {
        stopAgent(resolveAgent(name));
        return json({ ok: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 404);
      }
    }

    // POST /api/agents/:name/restart — reload the provider on the same conversation
    if (parts.length === 3 && parts[2] === "restart" && method === "POST") {
      const refused = await restartBody(req);
      if (refused) return refused;
      if (!readAgent(name)) return json({ error: `no local agent "${name}"` }, 404);
      try {
        await restartAgent(name);
        return json({ ok: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 409);
      }
    }

    if (parts.length === 3 && parts[2] === "model" && method === "POST") {
      const body = await modelSelectionBody(req);
      if (body instanceof Response) return body;
      const agent = readAgent(name);
      if (!agent) return json({ error: `no local agent "${name}"` }, 404);
      try {
        const selection = await restartExactAgent(agent, body, modelSelectionPrecondition(body));
        return json({ ok: true, ...selection });
      } catch (error) {
        return json({ error: (error as Error).message }, error instanceof SelectionError ? 400 : 409);
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

export function startApiServer(opts: { port?: number; hostname?: string; token: string; webOrigin?: string }): ApiServerHandle {
  const { token } = opts;
  const webAuth = opts.webOrigin ? createWebAuth(opts.webOrigin, token) : null;
  const terminal = createWebTerminal();
  let eventStreams = 0;
  let terminalResolutions = 0;
  const server = Bun.serve<TerminalData>({
    websocket: terminal.websocket,
    // Above Bun's 10s default: remote routes run ssh with up to 30s timeouts.
    idleTimeout: 120,
    maxRequestBodySize: PASTE_MAX_BYTES + 64 * 1024,
    port: opts.port ?? loadConfig().apiPort,
    hostname: opts.hostname ?? loadConfig().apiBind,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      const respond = (response: Response) => secureWebResponse(response);
      // Only image uploads get the large body limit; elsewhere a body must
      // declare its length (no chunked bypass) and stay under the JSON cap.
      if (!/^\/api\/agents\/[^/]+\/files$/.test(path)) {
        const length = req.headers.get("content-length");
        if (length === null ? req.body !== null : Number(length) > JSON_MAX_BYTES)
          return respond(json({ error: "request body too large" }, 413));
      }
      if (webAuth) {
        const authResponse = await webAuth.route(req, path);
        if (authResponse) return respond(authResponse);
        const assets: Record<string, string> = { "/": "web/index.html", "/index.html": "web/index.html", "/favicon.svg": "web/favicon.svg", "/app.js": "web/app.js", "/search.js": "web/search.js", "/style.css": "web/style.css", "/terminal.js": "web/terminal.js", "/links.js": "web/links.js", "/markdown.js": "web/markdown.js", "/transcript.js": "web/transcript.js", "/prompts.js": "web/prompts.js", "/usage.js": "web/usage.js", "/vendor/addon-web-links.js": "node_modules/@xterm/addon-web-links/lib/addon-web-links.js", "/vendor/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js", "/vendor/xterm.css": "node_modules/@xterm/xterm/css/xterm.css", "/vendor/addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js" };
        if ((req.method === "GET" || req.method === "HEAD") && assets[path]) {
          return respond(new Response(Bun.file(new URL("../" + assets[path], import.meta.url))));
        }
      }
      if (path === "/api" || path.startsWith("/api/")) {
        // Bearer header only. The old `?token=` query fallback existed for
        // the PWA's URL bootstrap; with that gone it would just leak the
        // token (an RCE credential) into proxy logs and shell history.
        const supplied = bearer(req);
        const bearerValid = supplied && tokensMatch(supplied, token);
        if (!bearerValid && !webAuth?.valid(req)) return respond(json({ error: "unauthorized" }, 401));
        if (!bearerValid && req.method !== "GET" && req.method !== "HEAD" && !webAuth?.sameOrigin(req)) {
          return respond(json({ error: "origin rejected" }, 403));
        }
        const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
        if (parts.length === 1 && parts[0] === "web-events") {
          if (!webAuth?.valid(req)) return respond(json({ error: "Browser session required" }, 401));
          // Same-origin EventSource GETs may omit Origin; browser-controlled
          // Fetch Metadata supplies the same-origin check in that case.
          if (req.headers.has("origin") ? !webAuth.sameOrigin(req) : req.headers.get("sec-fetch-site") !== "same-origin")
            return respond(json({ error: "origin rejected" }, 403));
          if (req.method !== "GET") return respond(json({ error: "method not allowed" }, 405));
          if (eventStreams >= 32) return respond(json({ error: "Too many event streams" }, 429));
          eventStreams++;
          let released = false;
          const release = () => { if (!released) { released = true; eventStreams--; } };
          try {
            const response = startWebEvents(req, {
              isSessionValid: () => webAuth.valid(req),
              onRevoke: (close) => {
                const unsubscribe = webAuth.subscribe(req, close);
                return () => { unsubscribe(); release(); };
              },
            });
            if (response.status !== 200) release();
            return respond(response);
          } catch (error) { release(); throw error; }
        }
        if (parts.length === 3 && parts[0] === "agents" && parts[2] === "terminal") {
          if (!webAuth) return respond(json({ error: "Web terminal is disabled; configure webOrigin" }, 403));
          const upgrading = req.headers.get("upgrade")?.toLowerCase() === "websocket";
          if (upgrading || req.headers.has("origin") ? !webAuth.sameOrigin(req) : req.headers.get("sec-fetch-site") !== "same-origin")
            return respond(json({ error: "origin rejected" }, 403));
          // Terminal connections intentionally require revocable browser sessions,
          // even when a valid bearer header was also supplied.
          if (!webAuth.valid(req)) return respond(json({ error: "Web terminal requires a browser session" }, 401));
          if (req.method !== "GET") return respond(json({ error: "method not allowed" }, 405));
          if (url.search) return respond(json({ error: "Terminal URL must not contain query parameters" }, 400));
          const target = parseTarget(parts[1]!);
          if (target instanceof Response) return respond(target);
          if (terminalResolutions >= 16 || (upgrading && server.pendingWebSockets >= 32))
            return respond(json({ error: "Too many terminal requests" }, 429));
          terminalResolutions++;
          let resolved;
          try { resolved = target.host ? await remoteTerminalTarget(target.host, target.name) : terminalTarget(target.name); }
          catch (error) { return respond(remoteFailure(error)); }
          finally { terminalResolutions--; }
          if (resolved instanceof Response) return respond(resolved);
          if (!webAuth.valid(req)) return respond(json({ error: "Session expired or revoked" }, 401));
          if (!upgrading) return respond(json({ available: true, transport: target.host ? "ssh" : "local" }));
          if (server.pendingWebSockets >= 32) return respond(json({ error: "Too many terminal connections" }, 429));
          if (server.upgrade(req, { data: {
            target: resolved,
            isValid: () => webAuth.valid(req),
            subscribe: (invalidate) => webAuth.subscribe(req, invalidate),
          } })) return;
          return respond(json({ error: "WebSocket upgrade required" }, 426));
        }
        if (!bearerValid && parts.length === 1 && parts[0] === "events") {
          return respond(json({ error: "event streams require bearer authentication; browser clients use polling" }, 403));
        }
        try {
          if (req.method === "POST" && parts.length === 3 && parts[0] === "agents" && parts[2] === "move") server.timeout(req, 0);
          return respond(await withAuditContext({
            source: bearerValid ? "http-api" : "web-front-desk",
            route: auditRoute(req, parts),
            actor: bearerValid ? "shared-bearer" : "browser-session",
            auth: bearerValid ? "bearer" : "browser-session",
            peer: server.requestIP(req)?.address,
          }, () => auditedApi(req, parts)));
        }
        catch { return respond(json({ error: "request failed" }, 500)); }
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
    stop: () => { terminal.stop(); webAuth?.dispose(); server.stop(true); },
    port,
    hostname,
    url: `http://${hostname}:${port}`,
  };
}
