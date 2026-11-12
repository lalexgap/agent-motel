// Pure parts of the token usage page: request paths, the refresh schedule,
// saved preferences, which connection to show and usage names to agent keys.
// The rendering is web/usage.js; the DOM glue is usageView.ts.
import { agentKey, parseAgentKey } from "./fleet";
import type { AgentRow } from "./types";

export type UsageRange = 1 | 7 | 30;
export type UsageUnit = "usd" | "tokens";
export const USAGE_RANGES: readonly UsageRange[] = [1, 7, 30];
export const USAGE_PROVIDERS = ["claude", "codex", "antigravity"] as const;
// The summary is cheap (a stored ledger); while the page is open it refreshes at most this often.
export const SUMMARY_INTERVAL_MS = 30_000;

export interface UsagePrefs {
  range: UsageRange;
  unit: UsageUnit;
  // Summary filters ("" = all).
  repo: string;
  provider: string;
  // The detailed breakdown's provider filter ("" = all).
  breakdownProvider: string;
  // Connection id the page last showed.
  connection: string | null;
}

export const DEFAULT_USAGE_PREFS: UsagePrefs = { range: 7, unit: "usd", repo: "", provider: "", breakdownProvider: "", connection: null };

const provider = (value: unknown): string =>
  typeof value === "string" && (USAGE_PROVIDERS as readonly string[]).includes(value) ? value : "";

export function parseUsagePrefs(raw: string | null): UsagePrefs {
  if (!raw) return { ...DEFAULT_USAGE_PREFS };
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof UsagePrefs, unknown>>;
    if (!data || typeof data !== "object") return { ...DEFAULT_USAGE_PREFS };
    return {
      range: USAGE_RANGES.includes(data.range as UsageRange) ? (data.range as UsageRange) : DEFAULT_USAGE_PREFS.range,
      unit: data.unit === "tokens" ? "tokens" : "usd",
      repo: typeof data.repo === "string" ? data.repo.trim().slice(0, 200) : "",
      provider: provider(data.provider),
      breakdownProvider: provider(data.breakdownProvider),
      connection: typeof data.connection === "string" && data.connection ? data.connection : null,
    };
  } catch {
    return { ...DEFAULT_USAGE_PREFS };
  }
}

export const serializeUsagePrefs = (prefs: UsagePrefs): string => JSON.stringify(prefs);

// GET /api/usage/summary, exactly as the browser UI asks: `quota=0` once quota
// has loaded, except that Refresh asks for `refresh=1` (fresh quota and ledger).
export function summaryPath(options: { range: UsageRange; repo: string; provider: string; refresh: boolean; quotaLoaded: boolean }): string {
  const params = new URLSearchParams({ range: String(options.range) });
  if (options.repo) params.set("repo", options.repo);
  if (options.provider) params.set("provider", options.provider);
  if (options.refresh) params.set("refresh", "1");
  else if (options.quotaLoaded) params.set("quota", "0");
  return "/api/usage/summary?" + params.toString();
}

// GET /api/usage for the detailed breakdown: never quota, optionally one local agent or provider.
export function breakdownPath(options: { agent: string; provider: string }): string {
  const params = new URLSearchParams({ quota: "0" });
  if (options.agent) params.set("agent", options.agent);
  if (options.provider) params.set("provider", options.provider);
  return "/api/usage?" + params.toString();
}

// Whether a periodic tick should fetch the summary: only while the page shows,
// the window is visible, and the last fetch is at least SUMMARY_INTERVAL_MS old.
export function periodicDue(options: { pageVisible: boolean; documentHidden: boolean; fetchedAt: number; now: number }): boolean {
  return options.pageVisible && !options.documentHidden && options.now - options.fetchedAt >= SUMMARY_INTERVAL_MS;
}

// The status line under the toolbar after a summary loads.
export function summaryStatus(summary: { generatedAt?: string; indexing?: { pendingFiles?: number } } | null | undefined, now = Date.now()): string {
  const pending = summary?.indexing?.pendingFiles || 0;
  if (pending > 0) return `Indexing history… ${pending} file${pending === 1 ? "" : "s"} left`;
  const at = new Date(summary?.generatedAt || now);
  return `Updated ${(Number.isFinite(at.getTime()) ? at : new Date(now)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// Usage is per server. An explicit request (the page opened for one agent) wins,
// then the open agent's connection, then the one last shown, then the first.
export function pickConnection(ids: readonly string[], options: { requested?: string | null; openKey?: string | null; saved?: string | null }): string | null {
  const open = options.openKey ? parseAgentKey(options.openKey)?.connection : null;
  for (const candidate of [options.requested, open, options.saved]) if (candidate && ids.includes(candidate)) return candidate;
  return ids[0] ?? null;
}

// Usage reports name local agents only (the server's own machine), by plain
// name. Their app key is that connection's row with no host; removed agents and
// names no longer in the fleet have nowhere to open.
export function usageAgentKey(connection: string, rows: readonly AgentRow[], name: string, status?: string): string | null {
  if (!name || status === "removed") return null;
  const row = rows.find((candidate) => !candidate.host && candidate.name === name);
  return row ? agentKey(connection, row) : null;
}

// What showUsage(key) scopes the breakdown to: the agent's name when it is a
// local agent (the per-agent breakdown is local only), else nothing.
export function scopeForKey(key: string): { connection: string; agent: string } | null {
  const parsed = parseAgentKey(key);
  if (!parsed) return null;
  return { connection: parsed.connection, agent: parsed.id.includes(":") ? "" : parsed.id };
}
