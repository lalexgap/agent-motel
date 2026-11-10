// Connection URL policy and api.get path rules. The dev bridge enforces these the
// same way the Swift ConnectionPolicy does; the page uses them for early feedback.

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

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const HOST_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,254}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const describe = (value: unknown): string => (value === undefined || value === null ? "null" : String(value));

// `name` or `host:name`.
export function checkAgent(value: unknown): Checked<string> {
  const invalid = { ok: false as const, error: `invalid agent: ${describe(value)}` };
  if (typeof value !== "string") return invalid;
  const parts = value.split(":");
  if (parts.length > 2) return invalid;
  const name = parts.pop()!;
  const host = parts[0];
  if (!AGENT_NAME_RE.test(name) || (host !== undefined && !HOST_RE.test(host))) return invalid;
  return { ok: true, value };
}

export function checkMode(value: unknown): Checked<SendMode> {
  return value === "queue" || value === "now" ? { ok: true, value } : { ok: false, error: MODE_INVALID };
}

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

// Trims the ends (the server trims too) and leaves the inside untouched.
export function checkMessageText(value: unknown): Checked<string> {
  if (typeof value !== "string") return { ok: false, error: "text must be a string" };
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
