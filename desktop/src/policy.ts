// Connection URL policy and api.get path rules. The dev bridge enforces these the
// same way the Swift ConnectionPolicy does; the page uses them for early feedback.
import type { TerminalControl } from "./types";

export type PolicyResult = { ok: true; url: string } | { ok: false; error: string };

const HTTP_ONLY_LOCAL = "Plain http is only allowed for localhost and Tailscale addresses; use https for anything else";

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

// Loopback, Tailscale's CGNAT range (100.64.0.0/10) and MagicDNS names are the
// only places a bearer token may travel without TLS.
export function plainHttpAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const octets = ipv4(host);
  if (octets) {
    const [a, b] = octets as [number, number, number, number];
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  return host.endsWith(".ts.net") && host.length > ".ts.net".length;
}

// Any path, query or fragment is dropped (as the Swift ConnectionPolicy does), so
// a URL pasted from the browser UI's address bar still works.
export function normalizeServerUrl(input: string): PolicyResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter the server URL" };
  if (!/^https?:\/\//i.test(text)) return { ok: false, error: "Start the URL with https:// (or http:// for localhost and Tailscale)" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only http and https URLs are supported" };
  if (url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(text)) return { ok: false, error: "Remove the user name or password from the URL" };
  if (!url.hostname) return { ok: false, error: "The URL needs a host" };
  if (url.protocol === "http:" && !plainHttpAllowed(url.hostname)) return { ok: false, error: HTTP_ONLY_LOCAL };
  return { ok: true, url: `${url.protocol}//${url.host}` };
}

// `path` is appended to a stored base URL, so it must not be able to change the
// origin or escape /api/: no dot segments (literal or percent-encoded), no
// backslashes, fragments, schemes, hosts or control characters.
export function validateApiPath(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "path is required";
  if (path.length > 2048) return "path is too long";
  if (!path.startsWith("/api/")) return "path must start with /api/";
  if (/[\u0000- \u007f\\#]/.test(path)) return "path contains a forbidden character";
  if (path.includes("..")) return "path must not contain ..";
  if (path.includes("//")) return "path must not contain a host";
  if (/%(2e|2f|5c|00)/i.test(path)) return "path contains a forbidden escape";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "path must not contain a scheme";
  const resolved = new URL(path, "http://base.invalid");
  if (resolved.origin !== "http://base.invalid" || !resolved.pathname.startsWith("/api/")) return "path must stay under /api/";
  return null;
}

// open.external: http/https without userinfo.
export function externalUrlAllowed(input: unknown): boolean {
  if (typeof input !== "string") return false;
  try {
    const url = new URL(input);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
}

// messages.send / messages.cancel. The bridge builds the request path from these
// parts itself, so the page can never aim a mutation anywhere else. The Swift
// MessagePolicy applies the same rules to the same test vectors.
export type SendMode = "queue" | "now";
export const MESSAGE_MAX_BYTES = 100_000;
export const MESSAGE_EMPTY = "Message is empty";
export const MESSAGE_TOO_LONG = "Message is too long (limit 100,000 bytes)";
export const MODE_INVALID = "mode must be queue or now";
export const MESSAGE_CONTROL = "Message contains a control character (only tabs and line breaks are allowed)";
// am types the text into the agent's pane, where Esc or Ctrl-C would act on the agent.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const HOST_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,254}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

// Objects and arrays get a fixed placeholder, as in the Swift MessagePolicy.describe.
export const OBJECT_PLACEHOLDER = "[object]";
const describe = (value: unknown): string =>
  value === undefined || value === null
    ? "null"
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : OBJECT_PLACEHOLDER;

const validHost = (host: string): boolean => HOST_RE.test(host) && !host.includes("..");

// `name` or `host:name`.
export function checkAgent(value: unknown): Checked<string> {
  const invalid = { ok: false as const, error: `invalid agent: ${describe(value)}` };
  if (typeof value !== "string") return invalid;
  const parts = value.split(":");
  if (parts.length > 2) return invalid;
  const name = parts.pop()!;
  const host = parts[0];
  if (!AGENT_NAME_RE.test(name) || (host !== undefined && !validHost(host))) return invalid;
  return { ok: true, value };
}

export function checkMode(value: unknown): Checked<SendMode> {
  return value === "queue" || value === "now" ? { ok: true, value } : { ok: false, error: MODE_INVALID };
}

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

// Trims the ends (the server trims too) and leaves the inside untouched.
export function checkMessageText(value: unknown): Checked<string> {
  if (typeof value !== "string") return { ok: false, error: "text must be a string" };
  if (CONTROL_RE.test(value)) return { ok: false, error: MESSAGE_CONTROL };
  const text = value.trim();
  if (!text) return { ok: false, error: MESSAGE_EMPTY };
  // Cheap bound first: every UTF-16 unit is at least one UTF-8 byte.
  if (text.length > MESSAGE_MAX_BYTES || utf8Length(text) > MESSAGE_MAX_BYTES) return { ok: false, error: MESSAGE_TOO_LONG };
  return { ok: true, value: text };
}

export function checkMessageId(value: unknown): Checked<string> {
  return typeof value === "string" && MESSAGE_ID_RE.test(value) ? { ok: true, value } : { ok: false, error: `invalid message id: ${describe(value)}` };
}

export const messagesPath = (agent: string, id?: string): string =>
  `/api/agents/${encodeURIComponent(agent)}/messages${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;

// Agent actions. Same principle as messages: the page passes
// values, and the request is built here from validated values only. The Swift
// ActionPolicy applies the same rules, vectors and error strings.
export interface ConfirmSpec {
  title: string;
  button: string;
  // Remove defaults to Cancel and styles its button as destructive.
  defaultIsCancel: boolean;
  // `status` is the agent's status from the existence pre-check.
  body(status: string): string;
}

export interface ActionRequest {
  method: "POST" | "DELETE";
  path: string;
  // A JSON object (sent as application/json) or raw bytes (files.upload).
  body?: Record<string, unknown> | Uint8Array<ArrayBuffer>;
  contentType?: string;
  timeoutMs: number;
  // Confirmed actions need the agent's exact-name detail route for the pre-check.
  confirm?: ConfirmSpec;
  precheckPath?: string;
}

export const CONFIRM_METHODS = ["agents.restart", "agents.interrupt", "agents.stop", "agents.remove", "agents.move", "agents.model"] as const;
export type ConfirmMethod = (typeof CONFIRM_METHODS)[number];
export const ACTION_METHODS = [
  "agents.resume",
  ...CONFIRM_METHODS,
  "agents.rename",
  "agents.handoff",
  "agents.create",
  "permissions.answer",
  "prompt.answer",
  "files.upload",
  "concierge.ensure",
  "search.query",
] as const;
export type ActionMethod = (typeof ACTION_METHODS)[number];
export const isConfirmMethod = (method: unknown): method is ConfirmMethod => (CONFIRM_METHODS as readonly unknown[]).includes(method);
export const isActionMethod = (method: unknown): method is ActionMethod => (ACTION_METHODS as readonly unknown[]).includes(method);

export const AGENT_GONE = "This agent no longer exists";
export const precheckFailed = (status: number): string => `Couldn't check the agent (HTTP ${status})`;
export const CONFIRM_OPEN = "another confirmation is open";

// Controls, format characters (bidi controls, zero-width and tag characters)
// and line/paragraph separators: invisible, or able to break or reorder the alert's text.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const EDGE_SPACE_RE = /^\p{Zs}+|\p{Zs}+$/gu;

// Text from outside the app shown in the alert (the pre-check status, the
// connection name, the server host): invisible characters dropped, space
// separators trimmed, at most 64 code points, "unknown" when nothing is left.
// ActionPolicy.displayText does the same.
export function displayText(raw: string): string {
  const clean = raw.replace(INVISIBLE_RE, "").replace(EDGE_SPACE_RE, "");
  return clean ? Array.from(clean).slice(0, 64).join("") : "unknown";
}

// The host[:port] of a stored, normalised `scheme://host[:port]` connection URL.
export function serverHost(url: string): string {
  const start = url.indexOf("://");
  return displayText(start < 0 ? url : url.slice(start + 3));
}

// The status from the pre-check's detail body, made safe to show in the alert.
export function precheckStatus(body: unknown): string {
  const raw = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { status?: unknown }).status : undefined;
  return typeof raw === "string" ? displayText(raw) : "unknown";
}
export const PROVIDERS = ["claude", "codex", "antigravity"] as const;
export const RUNNING_STATUSES = ["starting", "idle", "waiting", "working", "needs-attention"] as const;
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const SECOND = 1000;
const PERMISSION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROMPT_ID_RE = /^[a-f0-9]{32}$/;
const PROMPT_OPTION_RE = /^[1-9]$/;
const LINE_BREAK_RE = /[\n\r]/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

class Invalid extends Error {}
const fail = (error: string): never => {
  throw new Invalid(error);
};
const absent = (value: unknown): value is undefined | null => value === undefined || value === null;

// T(n) and, with singleLine, L(n): at most n UTF-8 bytes, no control characters
// other than tab and (for T) line breaks.
function freeText(value: unknown, maxBytes: number, singleLine: boolean): string | null {
  if (typeof value !== "string" || CONTROL_RE.test(value) || (singleLine && LINE_BREAK_RE.test(value))) return null;
  return value.length > maxBytes || utf8Length(value) > maxBytes ? null : value;
}

// The trimmed value is what gets sent; limits apply to it, as for message text.
function trimmedText(value: unknown, maxBytes: number, singleLine: boolean): string | null {
  if (typeof value !== "string" || CONTROL_RE.test(value) || (singleLine && LINE_BREAK_RE.test(value))) return null;
  const text = value.trim();
  return text && freeText(text, maxBytes, singleLine) !== null ? text : null;
}

const checkedName = (value: unknown): string =>
  typeof value === "string" && AGENT_NAME_RE.test(value) && value !== "concierge" ? value : fail(`invalid name: ${describe(value)}`);

const checkedHost = (value: unknown): string =>
  typeof value === "string" && (value === "local" || validHost(value)) ? value : fail(`invalid host: ${describe(value)}`);

function checkedDir(value: unknown, absoluteOnly: boolean): string {
  const dir = freeText(value, 4096, true);
  return dir !== null && (dir.startsWith("/") || (!absoluteOnly && dir.startsWith("~"))) ? dir : fail("invalid directory");
}

// model (L(256)) and effort (L(64)): trimmed, non-empty, not an option-like `-x`.
function checkedSetting(value: unknown, maxBytes: number, field: "model" | "effort"): string {
  const text = trimmedText(value, maxBytes, true);
  return text !== null && !text.startsWith("-") ? text : fail(`invalid ${field}`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fail(`invalid ${field}`);
}

const matching = (value: unknown, re: RegExp, field: string): string => (typeof value === "string" && re.test(value) ? value : fail(`invalid ${field}`));

const MAGIC: Record<(typeof UPLOAD_TYPES)[number], (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

// Standard base64 with padding, 1 byte to 10 MiB decoded. The decoded size is
// known from the length, so an oversized upload is refused before decoding.
function decodedImage(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) return fail("invalid data");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const size = (value.length / 4) * 3 - padding;
  if (size < 1 || size > UPLOAD_MAX_BYTES) return fail("invalid data");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const agentPath = (agent: string, rest = ""): string => `/api/agents/${encodeURIComponent(agent)}${rest}`;

function confirm(title: string, text: string, button: string, defaultIsCancel = false): ConfirmSpec {
  return { title, button, defaultIsCancel, body: (status) => `${text} Status: ${status}.` };
}

// The text the browser dev mode shows in window.confirm; the native alert shows
// the same three parts.
// `server` is the page-settable connection name; `url` is the stored connection URL, which the page
// cannot change without re-entering the token.
export const confirmMessage = (title: string, body: string, server: string, url: string): string =>
  `${title}\n\n${body}\n\nServer: ${displayText(server)} (${serverHost(url)})`;

function lifecycle(agent: string, action: string, timeoutMs: number, confirmSpec?: ConfirmSpec): ActionRequest {
  return {
    method: "POST",
    path: agentPath(agent, `/${action}`),
    body: {},
    contentType: "application/json",
    timeoutMs,
    ...(confirmSpec ? { confirm: confirmSpec, precheckPath: agentPath(agent) } : {}),
  };
}

const json = (path: string, body: Record<string, unknown>, timeoutMs: number): ActionRequest => ({
  method: "POST",
  path,
  body,
  contentType: "application/json",
  timeoutMs,
});

// Everything after the connection, which the bridge checks first. Validation
// runs in the contract's order: agent, then the other params as listed.
function build(method: string, params: Record<string, unknown>): ActionRequest {
  if (method === "concierge.ensure") return json("/api/concierge", {}, 120 * SECOND);
  if (method === "search.query") {
    const query = trimmedText(params.query, 256, true);
    if (query === null || [...query].length < 2) fail("invalid query");
    return json("/api/search", { query }, 30 * SECOND);
  }
  if (method === "agents.create") {
    const name = checkedName(params.name);
    const task = trimmedText(params.task, MESSAGE_MAX_BYTES, false) ?? fail("invalid task");
    const provider = oneOf(params.provider, PROVIDERS, "provider");
    const dir = absent(params.dir) ? undefined : checkedDir(params.dir, false);
    const host = absent(params.host) ? undefined : checkedHost(params.host);
    const remote = host !== undefined && host !== "local";
    if (remote && dir !== undefined && !dir.startsWith("/")) fail("invalid directory");
    const model = absent(params.model) ? undefined : checkedSetting(params.model, 256, "model");
    const effort = absent(params.effort) ? undefined : checkedSetting(params.effort, 64, "effort");
    const role = absent(params.role) ? undefined : matching(params.role, AGENT_NAME_RE, "role");
    if (role === "concierge") fail("invalid role");
    return json(
      "/api/agents",
      {
        name,
        task,
        provider,
        ...(dir === undefined ? {} : remote ? { remoteDir: dir } : { dir }),
        ...(remote ? { host } : {}),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(role === undefined ? {} : { role }),
      },
      150 * SECOND,
    );
  }

  const agentResult = checkAgent(params.agent);
  if (!agentResult.ok) fail(agentResult.error);
  const agent = (agentResult as { value: string }).value;
  switch (method) {
    case "agents.resume":
      return lifecycle(agent, "resume", 60 * SECOND);
    case "agents.restart":
      return lifecycle(agent, "restart", 60 * SECOND, confirm(`Restart ${agent}?`, "This interrupts its current turn and reopens the conversation.", "Restart"));
    case "agents.interrupt":
      return lifecycle(agent, "interrupt", 60 * SECOND, confirm(`Interrupt ${agent}?`, "This interrupts its current work.", "Interrupt"));
    case "agents.stop":
      return lifecycle(agent, "stop", 60 * SECOND, confirm(`Stop ${agent}?`, "This interrupts its current work and ends its session. It can be resumed later.", "Stop"));
    case "agents.remove":
      return {
        method: "DELETE",
        path: agentPath(agent),
        timeoutMs: 60 * SECOND,
        confirm: confirm(
          `Remove ${agent}?`,
          "Its session will stop and the agent will be removed, along with its queued messages. The worktree is kept.",
          "Remove",
          true,
        ),
        precheckPath: agentPath(agent),
      };
    case "agents.rename":
      return json(agentPath(agent, "/rename"), { name: checkedName(params.name) }, 60 * SECOND);
    case "agents.move": {
      const host = checkedHost(params.host);
      const dir = absent(params.dir) ? undefined : checkedDir(params.dir, true);
      return {
        ...json(agentPath(agent, "/move"), { host, ...(dir === undefined ? {} : { dir }) }, 600 * SECOND),
        confirm: confirm(`Move ${agent} to ${host}?`, "The source will stop; workspace files are not copied.", "Move"),
        precheckPath: agentPath(agent),
      };
    }
    case "agents.model": {
      if (params.model === undefined) fail("invalid model");
      const model = params.model === null ? null : checkedSetting(params.model, 256, "model");
      const effort = params.effort === undefined ? undefined : params.effort === null ? null : checkedSetting(params.effort, 64, "effort");
      const createdAt = freeText(params.createdAt, 128, true);
      if (!createdAt) fail("invalid createdAt");
      const status = oneOf(params.status, RUNNING_STATUSES, "status");
      return {
        ...json(agentPath(agent, "/model"), { model, ...(effort === undefined ? {} : { effort }), createdAt, status }, 120 * SECOND),
        confirm: confirm(
          `Change the model for ${agent}?`,
          "This restarts the agent and interrupts its current turn. The conversation and queued messages are kept.",
          "Change model",
        ),
        precheckPath: agentPath(agent),
      };
    }
    case "agents.handoff": {
      const to = oneOf(params.to, ["claude", "codex"] as const, "to");
      const newName = absent(params.newName) ? undefined : checkedName(params.newName);
      const full = absent(params.full) ? undefined : typeof params.full === "boolean" ? params.full : fail("invalid full");
      return json(
        agentPath(agent, "/handoff"),
        { to, ...(newName === undefined ? {} : { newName }), ...(full === undefined ? {} : { full }) },
        150 * SECOND,
      );
    }
    case "permissions.answer": {
      const id = matching(params.id, PERMISSION_ID_RE, "id");
      const optionId = matching(params.optionId, OPTION_ID_RE, "optionId");
      return json(agentPath(agent, `/permissions/${id}`), { optionId }, 45 * SECOND);
    }
    case "prompt.answer": {
      const id = matching(params.id, PROMPT_ID_RE, "id");
      const optionId = matching(params.optionId, PROMPT_OPTION_RE, "optionId");
      const text = absent(params.text) ? undefined : freeText(params.text, 2000, true) || fail("invalid text");
      return json(agentPath(agent, "/prompt"), { id, optionId, ...(text === undefined ? {} : { text }) }, 45 * SECOND);
    }
    case "files.upload": {
      const type = oneOf(params.type, UPLOAD_TYPES, "type");
      const bytes = decodedImage(params.data);
      if (!MAGIC[type](bytes)) fail(`File is not a valid ${type} image`);
      return { method: "POST", path: agentPath(agent, "/files"), body: bytes, contentType: type, timeoutMs: 120 * SECOND };
    }
  }
  return fail(`unknown method: ${method}`);
}

export function buildAction(method: unknown, params: Record<string, unknown>): Checked<ActionRequest> {
  if (!isActionMethod(method)) return { ok: false, error: `unknown method: ${describe(method)}` };
  try {
    return { ok: true, value: build(method, params) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

// Interactive terminal (terminal.*). The page passes values; the bridge builds the
// sign-in, preflight and WebSocket requests from the stored connection URL and the
// validated agent key. The Swift TerminalPolicy applies the same rules, vectors and strings.
export const TERMINAL_METHODS = ["terminal.open", "terminal.input", "terminal.resize", "terminal.close"] as const;
export type TerminalMethod = (typeof TERMINAL_METHODS)[number];
export const isTerminalMethod = (method: unknown): method is TerminalMethod => (TERMINAL_METHODS as readonly unknown[]).includes(method);

export const MAX_TERMINALS = 4;
export const TERMINAL_INPUT_MAX_BYTES = 16 * 1024;
export const TERMINAL_COLS = { min: 2, max: 500 } as const;
export const TERMINAL_ROWS = { min: 2, max: 200 } as const;
// Output is coalesced for up to 16 ms or 64 KiB per terminal.output event, in order.
export const TERMINAL_OUTPUT_EVENT_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_EVENT_MS = 16;
// More output than this waiting to be delivered to the page closes the terminal with 1013.
export const TERMINAL_PENDING_MAX_BYTES = 4 * 1024 * 1024;
// Input written to the socket but not yet sent; more closes the terminal with 1008.
export const TERMINAL_QUEUED_INPUT_MAX_BYTES = 1024 * 1024;
export const TERMINAL_PING_MS = 30_000;
// Each of sign-in, preflight and upgrade.
export const TERMINAL_STEP_TIMEOUT_MS = 30_000;
// Larger server text frames are dropped.
export const TERMINAL_CONTROL_MAX_BYTES = 64 * 1024;
export const TERMINAL_SESSION_COOKIE = "__Host-am_session";

export const TERMINAL_UNKNOWN = "unknown terminal";
export const TERMINAL_TOO_MANY = "Too many terminals open";
export const TERMINAL_TOKEN_REJECTED = "The server rejected the access token";
export const TERMINAL_NO_WEB_SIGNIN = "This server has no web sign-in, so terminals are unavailable";
export const TERMINAL_SIGNIN_LIMIT = "Too many sign-in attempts. Wait a minute and try again.";
export const TERMINAL_CONNECTIONS_LIMIT = "Too many terminal connections";
export const TERMINAL_UNREACHABLE = "Couldn't reach the server";
export const TERMINAL_NEEDS_HTTPS = "Terminals need an https connection";
// A 401 from the preflight or upgrade right after a fresh sign-in.
export const TERMINAL_SESSION_REJECTED = "The server rejected the terminal session";
// A 200 sign-in without a usable __Host-am_session cookie.
export const TERMINAL_NO_SESSION = "The server did not start a terminal session";
// A 200 preflight without {available: true, transport: "local"|"ssh"}.
export const TERMINAL_UNEXPECTED = "This server did not answer like Agent Motel";
// The page reloaded (its terminals were closed) while terminal.open was in progress.
export const TERMINAL_PAGE_CHANGED = "The page changed while the terminal was opening";
// An empty, or entirely invisible, server message.
export const TERMINAL_UNAVAILABLE = "Terminal unavailable";
export const terminalHttpError = (status: number): string => `The server returned HTTP ${status}`;
// The parenthetical is left out when the server's web address is not known (no route reports it).
export const terminalOriginRejected = (webOrigin?: string): string =>
  `This server only allows terminals from its own web address${webOrigin ? ` (${webOrigin})` : ""}. Connect the app to that address to use terminals.`;

// Codes and reasons of the closes the bridge itself makes (terminal.closed).
export const TERMINAL_CLOSE = {
  closed: { code: 1000, reason: "Terminal closed" },
  // The connection was removed or its URL changed.
  removed: { code: 1006, reason: "The connection was removed or changed" },
  lost: { code: 1006, reason: "Connection lost" },
  inputOverflow: { code: 1008, reason: "Terminal input limit exceeded" },
  outputOverflow: { code: 1013, reason: "Output exceeded rendering capacity" },
} as const;

// The session cookie only travels over TLS, or over plain http to this machine (the fixture).
export function terminalTransportAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  return ipv4(host)?.[0] === 127;
}

// `^[a-f0-9]{32}$`; anything else cannot name a terminal.
export const checkTerminalId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

// 1 to 16,384 UTF-8 bytes of anything: control keys are the point of a terminal.
export function checkTerminalInput(value: unknown): Checked<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > TERMINAL_INPUT_MAX_BYTES || utf8Length(value) > TERMINAL_INPUT_MAX_BYTES)
    return { ok: false, error: "invalid data" };
  return { ok: true, value };
}

const inRange = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;

export function checkTerminalSize(cols: unknown, rows: unknown): Checked<{ cols: number; rows: number }> {
  if (!inRange(cols, TERMINAL_COLS)) return { ok: false, error: "invalid cols" };
  if (!inRange(rows, TERMINAL_ROWS)) return { ok: false, error: "invalid rows" };
  return { ok: true, value: { cols, rows } };
}

// Built from a stored, normalised `scheme://host[:port]` URL and a checked agent key:
// POST <base>/auth/login; GET and upgrade on <base>/api/agents/<key>/terminal (wss for https).
export function terminalRequests(base: string, agent: string): { origin: string; login: string; terminal: string; socket: string } {
  const terminal = `${base}${agentPath(agent, "/terminal")}`;
  return { origin: base, login: `${base}/auth/login`, terminal, socket: terminal.replace(/^http/, "ws") };
}

// The __Host-am_session value from a login response's Set-Cookie header (repeated headers
// joined with commas, as Foundation does). Other cookies are ignored; a value that is not
// 16 to 512 base64url characters is refused, so it can never inject anything into a header.
export function sessionFromSetCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const piece of header.split(",")) {
    const pair = piece.split(";", 1)[0]!;
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    if (pair.slice(0, equals).trim() !== TERMINAL_SESSION_COOKIE) continue;
    const value = pair.slice(equals + 1).trim();
    return /^[A-Za-z0-9_-]{16,512}$/.test(value) ? value : null;
  }
  return null;
}

// null for a successful sign-in (the cookie is checked separately).
export function terminalLoginError(status: number): string | null {
  switch (status) {
    case 200:
      return null;
    case 401:
      return TERMINAL_TOKEN_REJECTED;
    case 403:
      return terminalOriginRejected();
    case 404:
      return TERMINAL_NO_WEB_SIGNIN;
    case 429:
      return TERMINAL_SIGNIN_LIMIT;
    default:
      return terminalHttpError(status);
  }
}

// `unauthorized`: no session, or one the server forgot; sign in once more and retry the step once.
export type TerminalOutcome = { ok: true; transport: "local" | "ssh" } | { ok: false; unauthorized: true } | { ok: false; error: string };

export function terminalPreflightOutcome(status: number, body: unknown): TerminalOutcome {
  const object = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  switch (status) {
    case 200:
      return object.available === true && (object.transport === "local" || object.transport === "ssh")
        ? { ok: true, transport: object.transport }
        : { ok: false, error: TERMINAL_UNEXPECTED };
    case 401:
      return { ok: false, unauthorized: true };
    case 403:
      return { ok: false, error: terminalOriginRejected() };
    case 404:
    case 409:
      return { ok: false, error: typeof object.error === "string" ? terminalServerText(object.error) : terminalHttpError(status) };
    case 429:
      return { ok: false, error: TERMINAL_CONNECTIONS_LIMIT };
    default:
      return { ok: false, error: terminalHttpError(status) };
  }
}

// A refused upgrade has no readable body; status 0 means it never got an HTTP answer.
export function terminalUpgradeOutcome(status: number): Exclude<TerminalOutcome, { ok: true }> {
  switch (status) {
    case 0:
      return { ok: false, error: TERMINAL_UNREACHABLE };
    case 401:
      return { ok: false, unauthorized: true };
    case 403:
      return { ok: false, error: terminalOriginRejected() };
    case 429:
      return { ok: false, error: TERMINAL_CONNECTIONS_LIMIT };
    default:
      return { ok: false, error: terminalHttpError(status) };
  }
}

// Server-supplied text shown to the person: controls, format characters and line/paragraph
// separators dropped, at most 300 code points, space separators trimmed, never empty.
export function terminalServerText(raw: string): string {
  const kept = Array.from(raw.replace(INVISIBLE_RE, "")).slice(0, 300).join("");
  return kept.replace(EDGE_SPACE_RE, "") || TERMINAL_UNAVAILABLE;
}

// A server close frame's reason: empty stays empty.
export const terminalCloseReason = (raw: string): string => (raw ? terminalServerText(raw) : "");

// A server TEXT frame, reduced to the three known messages; anything else is null (dropped).
export function parseTerminalControl(text: string): TerminalControl | null {
  if (text.length > TERMINAL_CONTROL_MAX_BYTES || utf8Length(text) > TERMINAL_CONTROL_MAX_BYTES) return null;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const { type, code, message: detail } = message as { type?: unknown; code?: unknown; message?: unknown };
  if (type === "ready") return { type: "ready" };
  if (type === "exit" && typeof code === "number" && Number.isInteger(code) && Math.abs(code) < 1e9) return { type: "exit", code };
  if (type === "error" && typeof detail === "string") return { type: "error", message: terminalServerText(detail) };
  return null;
}

// The consent question: a native sheet in the app (buttons Allow / Cancel, checkbox
// "Don't ask again for this server"), window.confirm in browser dev mode.
export function terminalConsent(name: string, url: string): { title: string; body: string } {
  return {
    title: `Open interactive terminals on ${displayText(name)}?`,
    body: `Keys you type in a terminal go straight to the agent's terminal on ${serverHost(url)}, including Ctrl-C and shell commands.`,
  };
}
export const terminalConsentMessage = (name: string, url: string): string => {
  const { title, body } = terminalConsent(name, url);
  return `${title}\n\n${body}`;
};
