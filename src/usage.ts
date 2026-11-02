import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { codexHome } from "./codexHooks";
import { loadConfig, localHostIdentity } from "./config";
import { baseDir } from "./paths";

// Quota headroom for the whole fleet, the same numbers `/usage` shows inside
// Claude Code and `/status` shows inside Codex — read WITHOUT touching any
// agent's pane, so checking it never interrupts a turn. Limits are per
// ACCOUNT, not per agent or per host, so one local reading describes the
// whole fleet.
//
// Claude publishes them over its OAuth API (the same endpoint the /usage
// panel calls). Codex has no such endpoint, but writes a rate-limit snapshot
// into its session log on every turn, so the newest snapshot on disk is the
// last thing the server told us — hence `observedAt`: a codex reading is only
// as fresh as the last codex turn on this machine.

export type UsageProvider = "claude" | "codex";

export interface UsageWindow {
  // Short window name: "5h", "week", "week (opus)".
  label: string;
  // Percent of the window's allowance consumed, 0-100.
  utilization: number;
  resetsAt?: string;
}

export interface ProviderUsage {
  provider: UsageProvider;
  windows: UsageWindow[];
  plan?: string;
  // When the numbers were measured. Live for claude, "last codex turn" for
  // codex — absent means "now".
  observedAt?: string;
  // Why there are no windows: not signed in, expired auth, request failed.
  error?: string;
}

export interface UsageReport {
  generatedAt: string;
  host?: string;
  providers: ProviderUsage[];
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The beta header Claude Code's own OAuth calls carry; the endpoint 401s
// without it.
const OAUTH_BETA = "oauth-2025-04-20";
const FETCH_TIMEOUT_MS = 8000;

// A codex reading older than this is called out as stale rather than passed
// off as current.
export const STALE_OBSERVATION_SECONDS = 1800;

function claudeCredentialsFile(): string {
  // process.env.HOME (not os.homedir()) so tests can sandbox it — same
  // reasoning as claudeProjectsDir in paths.ts.
  return join(process.env.HOME ?? homedir(), ".claude", ".credentials.json");
}

interface ClaudeOAuth {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

export interface CredentialRead {
  auth: ClaudeOAuth | null;
  // Set when credentials exist but this process may not read them, which is
  // a different answer than "not signed in" and deserves a different message.
  unavailable?: string;
}

// `security` exits 44 when the item genuinely isn't there; anything else
// (36 = interaction not allowed) means it exists but is out of reach.
const KEYCHAIN_ITEM_NOT_FOUND = 44;

// macOS Claude Code keeps credentials in the login keychain instead of a
// dotfile; the JSON payload is identical. Over ssh the keychain is locked to
// the GUI session and `security` has no way to prompt, so this reports the
// lock rather than pretending nobody is signed in.
function keychainCredentials(): { raw: string | null; locked: boolean } {
  if (platform() !== "darwin") return { raw: null, locked: false };
  const result = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  if (result.exitCode === 0) return { raw: result.stdout.toString().trim() || null, locked: false };
  return { raw: null, locked: result.exitCode !== KEYCHAIN_ITEM_NOT_FOUND };
}

export function readClaudeCredentials(): CredentialRead {
  let raw: string | null = null;
  const file = claudeCredentialsFile();
  if (existsSync(file)) {
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return { auth: null, unavailable: "credentials file unreadable" };
    }
  } else {
    const keychain = keychainCredentials();
    if (keychain.locked) {
      return { auth: null, unavailable: "macOS keychain is locked to the desktop session (try a local terminal, not ssh)" };
    }
    raw = keychain.raw;
  }
  if (!raw) return { auth: null };
  try {
    return { auth: JSON.parse(raw).claudeAiOauth ?? null };
  } catch {
    return { auth: null };
  }
}

export function claudeOAuth(): ClaudeOAuth | null {
  return readClaudeCredentials().auth;
}

// Only the windows a Claude subscription actually meters. The endpoint also
// returns codenamed buckets for unreleased features; those are ignored rather
// than rendered as mystery rows.
const CLAUDE_WINDOWS: Array<[key: string, label: string]> = [
  ["five_hour", "5h"],
  ["seven_day", "week"],
  ["seven_day_opus", "week (opus)"],
  ["seven_day_sonnet", "week (sonnet)"],
];

export function parseClaudeUsage(payload: unknown, plan?: string): ProviderUsage {
  const usage: ProviderUsage = { provider: "claude", windows: [], ...(plan ? { plan } : {}) };
  if (!payload || typeof payload !== "object") {
    return { ...usage, error: "unexpected response" };
  }
  const body = payload as Record<string, any>;
  for (const [key, label] of CLAUDE_WINDOWS) {
    const window = body[key];
    if (!window || typeof window.utilization !== "number") continue;
    usage.windows.push({
      label,
      utilization: window.utilization,
      ...(typeof window.resets_at === "string" ? { resetsAt: window.resets_at } : {}),
    });
  }
  // Pay-as-you-go on top of the subscription: only meaningful once enabled.
  const extra = body.extra_usage;
  if (extra?.is_enabled && typeof extra.utilization === "number") {
    usage.windows.push({ label: "extra usage", utilization: extra.utilization });
  }
  return usage;
}

// How long to wait before re-reading credentials that gave us nothing usable.
const OAUTH_RETRY_MS = 5 * 60_000;
let oauthCache: { value: CredentialRead; readAt: number } | null = null;

// On macOS the credentials live in the login keychain, so reading them spawns
// `security` synchronously — on the UI's event loop, once per poll, with a
// modal prompt possible if the keychain ACL doesn't trust it. A token good for
// hours is read once; anything unusable is retried on a slow timer instead.
function cachedClaudeCredentials(): CredentialRead {
  const cached = oauthCache;
  if (cached) {
    const expiresAt = cached.value.auth?.expiresAt;
    if (expiresAt && expiresAt > Date.now()) return cached.value;
    if (Date.now() - cached.readAt < OAUTH_RETRY_MS) return cached.value;
  }
  const value = readClaudeCredentials();
  oauthCache = { value, readAt: Date.now() };
  return value;
}

const CLAUDE_CACHE_TTL_MS = 3 * 60_000;
const CLAUDE_RATE_LIMIT_MIN_COOLDOWN_MS = 5 * 60_000;
const CLAUDE_RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 60_000;

interface ClaudeUsageDiskCache {
  usage?: ProviderUsage;
  fetchedAt?: string;
  backoffUntil?: number;
  failures?: number;
  lastError?: string;
}

function claudeUsageCacheFile(): string {
  return join(baseDir(), "claude-usage-cache.json");
}

export function readClaudeUsageCache(): ClaudeUsageDiskCache {
  const file = claudeUsageCacheFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeClaudeUsageCache(next: ClaudeUsageDiskCache): void {
  const dir = baseDir();
  const file = claudeUsageCacheFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(next) + "\n");
    renameSync(tmp, file);
  } catch {
    // best-effort shared cache
  }
}

export async function fetchClaudeUsage(opts: { bypassCache?: boolean } = {}): Promise<ProviderUsage> {
  const { auth, unavailable } = cachedClaudeCredentials();
  if (unavailable) {
    return { provider: "claude", windows: [], error: unavailable };
  }
  if (!auth?.accessToken) {
    return { provider: "claude", windows: [], error: "not signed in (run `claude` to authenticate)" };
  }
  if (auth.expiresAt && auth.expiresAt <= Date.now()) {
    // Refreshing here would rotate the token out from under every running
    // Claude Code session, so report it instead of racing them for it.
    return { provider: "claude", windows: [], error: "auth token expired (open a claude session to refresh)" };
  }

  const now = Date.now();
  const diskCache = readClaudeUsageCache();
  const cachedUsage = diskCache.usage?.windows?.length ? diskCache.usage : undefined;
  const fetchedMs = diskCache.fetchedAt ? Date.parse(diskCache.fetchedAt) : NaN;

  // Serve fresh shared disk reading so multiple local processes (__sidebar,
  // am-web, am-serve, CLI) don't hammer Anthropic's OAuth usage endpoint.
  if (!opts.bypassCache && cachedUsage && Number.isFinite(fetchedMs) && now - fetchedMs < CLAUDE_CACHE_TTL_MS) {
    return now - fetchedMs >= 60_000
      ? { ...cachedUsage, observedAt: diskCache.fetchedAt }
      : cachedUsage;
  }

  // Respect active 429 cooldown window across all local processes.
  if (diskCache.backoffUntil && diskCache.backoffUntil > now) {
    if (cachedUsage && diskCache.fetchedAt) {
      return { ...cachedUsage, observedAt: diskCache.fetchedAt };
    }
    const waitMin = Math.max(1, Math.ceil((diskCache.backoffUntil - now) / 60_000));
    return {
      provider: "claude",
      windows: [],
      ...(auth.subscriptionType ? { plan: auth.subscriptionType } : {}),
      error: diskCache.lastError ?? `usage endpoint rate-limited (HTTP 429 — cooling down, ~${waitMin}m remaining)`,
    };
  }

  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        const prevFailures = diskCache.failures ?? 0;
        const retryHeader = Number(response.headers.get("retry-after"));
        const expCooldown = Math.min(
          CLAUDE_RATE_LIMIT_MIN_COOLDOWN_MS * 2 ** prevFailures,
          CLAUDE_RATE_LIMIT_MAX_COOLDOWN_MS,
        );
        const cooldownMs =
          Number.isFinite(retryHeader) && retryHeader > 0
            ? Math.max(retryHeader * 1000, CLAUDE_RATE_LIMIT_MIN_COOLDOWN_MS)
            : expCooldown;
        const waitMin = Math.max(1, Math.ceil(cooldownMs / 60_000));
        const errorMsg =
          response.status === 429
            ? `usage endpoint rate-limited (HTTP 429 — backing off ${waitMin}m)`
            : `usage request failed (HTTP ${response.status})`;
        writeClaudeUsageCache({
          ...diskCache,
          backoffUntil: Date.now() + cooldownMs,
          failures: prevFailures + 1,
          lastError: errorMsg,
        });
        if (cachedUsage && diskCache.fetchedAt) {
          return { ...cachedUsage, observedAt: diskCache.fetchedAt };
        }
        return {
          provider: "claude",
          windows: [],
          ...(auth.subscriptionType ? { plan: auth.subscriptionType } : {}),
          error: errorMsg,
        };
      }
      return { provider: "claude", windows: [], error: `usage request failed (HTTP ${response.status})` };
    }
    const parsed = parseClaudeUsage(await response.json(), auth.subscriptionType);
    if (parsed.windows.length > 0 && !parsed.error) {
      writeClaudeUsageCache({
        usage: parsed,
        fetchedAt: new Date().toISOString(),
        backoffUntil: 0,
        failures: 0,
      });
    }
    return parsed;
  } catch (error) {
    if (cachedUsage && diskCache.fetchedAt) {
      return { ...cachedUsage, observedAt: diskCache.fetchedAt };
    }
    return { provider: "claude", windows: [], error: `usage request failed (${(error as Error).message})` };
  }
}

// How many of codex's session logs to inspect. Sorted newest-write-first, so
// a handful covers every conversation that could hold the latest snapshot —
// including a days-old session that is still being appended to.
const CODEX_SESSION_FILES = 6;
// Snapshots sit at the end of a rollout log; reading the tail keeps a
// multi-megabyte transcript from being parsed in full.
const CODEX_TAIL_BYTES = 256 * 1024;

function readTail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function codexSessionFiles(): string[] {
  const dir = join(codexHome(), "sessions");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(entry.parentPath ?? dir, entry.name))
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, CODEX_SESSION_FILES)
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

// 300 -> "5h", 10080 -> "week": the two windows codex actually meters, with a
// generic fallback so a new window shape still renders.
export function formatWindowMinutes(minutes: number): string {
  if (minutes === 10080) return "week";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

interface CodexSnapshot {
  windows: UsageWindow[];
  plan?: string;
  observedAt: string;
}

// One `token_count` payload's rate_limits block. Codex reports a primary and
// (on some plans) a secondary window; either may be absent.
export function parseCodexRateLimits(rateLimits: unknown, observedAt: string): CodexSnapshot | null {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const limits = rateLimits as Record<string, any>;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = limits[key];
    if (!window || typeof window.used_percent !== "number") continue;
    windows.push({
      label: typeof window.window_minutes === "number" ? formatWindowMinutes(window.window_minutes) : key,
      utilization: window.used_percent,
      ...(typeof window.resets_at === "number"
        ? { resetsAt: new Date(window.resets_at * 1000).toISOString() }
        : {}),
    });
  }
  if (windows.length === 0) return null;
  return {
    windows,
    ...(typeof limits.plan_type === "string" ? { plan: limits.plan_type } : {}),
    observedAt,
  };
}

// The newest rate-limit snapshot codex has written locally. Newest by the
// snapshot's own timestamp, not by file: several sessions can be live at once.
export function readCodexUsage(): ProviderUsage {
  let newest: CodexSnapshot | null = null;
  for (const file of codexSessionFiles()) {
    const tail = readTail(file, CODEX_TAIL_BYTES);
    // Walk backwards: the last usable snapshot in a log wins, and stopping
    // there avoids parsing every line of the tail. Codex also emits
    // token_count events carrying `"rate_limits":null`, so a line mentioning
    // rate_limits isn't necessarily a reading — keep going until one is.
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"rate_limits"')) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        // A truncated first line is expected — the tail starts mid-record.
        continue;
      }
      const snapshot = parseCodexRateLimits(
        entry?.payload?.info?.rate_limits ?? entry?.payload?.rate_limits ?? entry?.rate_limits,
        typeof entry?.timestamp === "string" ? entry.timestamp : new Date(statSync(file).mtimeMs).toISOString(),
      );
      if (!snapshot) continue;
      if (!newest || snapshot.observedAt > newest.observedAt) newest = snapshot;
      break;
    }
  }
  if (!newest) {
    return {
      provider: "codex",
      windows: [],
      error: "no rate-limit data yet (run a codex agent once)",
    };
  }
  return { provider: "codex", ...newest };
}

export async function collectUsage(opts: { providers?: UsageProvider[] } = {}): Promise<UsageReport> {
  const wanted = opts.providers ?? ["claude", "codex"];
  const providers: ProviderUsage[] = [];
  // Only claude does I/O worth overlapping; codex is a local file read.
  const claude = wanted.includes("claude") ? fetchClaudeUsage() : null;
  if (claude) providers.push(await claude);
  if (wanted.includes("codex")) providers.push(readCodexUsage());
  // Named so a reading collected over ssh (`am -H laptop usage --json`) says
  // whose machine it describes — codex freshness is per-host.
  return { generatedAt: new Date().toISOString(), host: localHostIdentity(), providers };
}

export function observationAgeSeconds(usage: ProviderUsage, now: Date = new Date()): number | null {
  if (!usage.observedAt) return null;
  const at = Date.parse(usage.observedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 1000));
}

export function isStale(usage: ProviderUsage, now: Date = new Date()): boolean {
  const age = observationAgeSeconds(usage, now);
  return age !== null && age >= STALE_OBSERVATION_SECONDS;
}

// "4h21m" / "3d" — how long until the window rolls over. Null once it has.
export function formatResetIn(resetsAt: string | undefined, now: Date = new Date()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.floor((at - now.getTime()) / 1000);
  if (seconds <= 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function usageBar(utilization: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((utilization / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Traffic-light thresholds shared by the report and the picker badge, so a
// window that reads "hot" in one place reads hot in the other.
export function usageLevel(utilization: number): "ok" | "warn" | "hot" {
  if (utilization >= 90) return "hot";
  if (utilization >= 75) return "warn";
  return "ok";
}

function levelColor(utilization: number): string {
  const level = usageLevel(utilization);
  return level === "hot" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : "\x1b[32m";
}

// "as of 16:54, 2h ago" — only meaningful for a reading that isn't live.
function observedNote(usage: ProviderUsage, now: Date): string | null {
  const age = observationAgeSeconds(usage, now);
  if (age === null) return null;
  const time = new Date(usage.observedAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const ago = age < 60 ? "just now" : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`;
  return `(as of ${time}, ${ago}${isStale(usage, now) ? " — stale" : ""})`;
}

export function formatUsageReport(report: UsageReport, opts: { color?: boolean } = {}): string[] {
  const now = new Date(report.generatedAt);
  const color = opts.color ?? true;
  const paint = (text: string, code: string) => (color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [];
  for (const usage of report.providers) {
    if (lines.length > 0) lines.push("");
    const observed = observedNote(usage, now);
    lines.push([
      paint(usage.provider, BOLD),
      usage.plan ? `${paint("·", DIM)} ${usage.plan}` : "",
      observed ? ` ${paint(observed, DIM)}` : "",
    ].filter(Boolean).join(" "));
    if (usage.error) {
      lines.push(`  ${paint(usage.error, DIM)}`);
      continue;
    }
    const labelWidth = Math.max(...usage.windows.map((w) => w.label.length));
    for (const window of usage.windows) {
      const bar = paint(usageBar(window.utilization), levelColor(window.utilization));
      const percent = `${Math.round(window.utilization)}%`.padStart(4);
      const resetIn = formatResetIn(window.resetsAt, now);
      const reset = resetIn ? `  ${paint(`resets in ${resetIn}`, DIM)}` : "";
      lines.push(`  ${window.label.padEnd(labelWidth)}  ${bar} ${percent}${reset}`);
    }
  }
  return lines.length > 0 ? lines : ["No usage data."];
}

// Quotas move slowly, and the footer is a glance, not a dashboard — one poll
// a minute is plenty and keeps the claude request rare.
const BADGE_REFRESH_MS = 60_000;
let badgeCache: string | null = null;

// What the footer paints. A plain read of the last poll: the UI repaints every
// second and must never block, and a formatter that fetched on demand would
// mean a network call every time anything rendered a key bar (tests included).
export function usageBadge(): string | null {
  return badgeCache;
}

// Ceiling for the backoff below: a hub left open for days against a provider
// that keeps failing settles here rather than asking every minute forever.
const BADGE_MAX_REFRESH_MS = 15 * 60_000;

// Poll delay after `failures` consecutive empty readings — offline, throttled,
// or simply not signed in all look the same from here, and all deserve to be
// asked about less often.
export function usagePollDelay(failures: number): number {
  if (failures <= 0) return BADGE_REFRESH_MS;
  return Math.min(BADGE_REFRESH_MS * 2 ** failures, BADGE_MAX_REFRESH_MS);
}

// Started by the UI for as long as it's on screen; returns its own stopper.
// Nothing polls unless something is watching.
export function startUsagePolling(): () => void {
  if (!loadConfig().showUsage) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let stopped = false;
  const refresh = () => {
    void collectUsage()
      .then((report) => {
        badgeCache = formatUsageBadge(report);
        // Back off when no provider has data OR when any provider failed
        // (e.g. Claude HTTP 429 while Codex has local session data).
        const anyError = report.providers.some((p) => Boolean(p.error));
        failures = badgeCache === null || anyError ? failures + 1 : 0;
      })
      .catch(() => {
        badgeCache = null;
        failures += 1;
      })
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(refresh, usagePollDelay(failures));
        timer.unref?.();
      });
  };
  refresh();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    badgeCache = null;
  };
}

// One-line form for the picker/hub footer: "claude 11%/5h · 75%/wk · codex 16%/wk".
// Providers with nothing to say are dropped rather than shown as errors —
// the footer is glanceable status, not diagnostics (`am usage` has those).
export function formatUsageBadge(report: UsageReport, now: Date = new Date()): string | null {
  const parts: string[] = [];
  for (const usage of report.providers) {
    if (usage.windows.length === 0) continue;
    const windows = usage.windows
      .filter((w) => w.label === "5h" || w.label === "week")
      .map((w) => `${Math.round(w.utilization)}%/${w.label === "week" ? "wk" : w.label}`);
    if (windows.length === 0) continue;
    parts.push(`${usage.provider} ${windows.join(" ")}${isStale(usage, now) ? "?" : ""}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
