// Pure parts of the PRs page: the request path, when to refetch, saved
// preferences, the report's agent keys to app keys, and nudge text into a
// draft. The rendering is web/prs.js; the DOM glue is prsView.ts.
import { agentId, agentKey } from "./fleet";
import type { AgentRow } from "./types";

// While the page shows and the window is visible: two inputs to the report
// (the GitHub sweep and decisions) raise no fleet event, so it also refetches on this clock.
export const PRS_INTERVAL_MS = 60_000;
// While the page is not showing, fleet events refetch at most this often, for the nav badge.
export const PRS_BACKGROUND_MS = 30_000;

export interface PrsPrefs {
  includeOlder: boolean;
  connection: string | null;
}

export const DEFAULT_PRS_PREFS: PrsPrefs = { includeOlder: false, connection: null };

export function parsePrsPrefs(raw: string | null): PrsPrefs {
  if (!raw) return { ...DEFAULT_PRS_PREFS };
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof PrsPrefs, unknown>> | null;
    if (!data || typeof data !== "object") return { ...DEFAULT_PRS_PREFS };
    return {
      includeOlder: data.includeOlder === true,
      connection: typeof data.connection === "string" && data.connection ? data.connection : null,
    };
  } catch {
    return { ...DEFAULT_PRS_PREFS };
  }
}

export const serializePrsPrefs = (prefs: PrsPrefs): string => JSON.stringify(prefs);

// GET /api/prs; "include older" asks for merged and closed PRs past the recent
// window. Repo, state and needs-me filter in the page, as in the browser UI.
export const prsPath = (includeOlder: boolean): string => (includeOlder ? "/api/prs?all=1" : "/api/prs");

// The periodic clock's question: fetch now?
export function periodicDue(options: { pageVisible: boolean; documentHidden: boolean; fetchedAt: number; now: number }): boolean {
  return options.pageVisible && !options.documentHidden && options.now - options.fetchedAt >= PRS_INTERVAL_MS;
}

// After a fleet event: how long to wait before refetching. Right away while the
// page shows; otherwise at most once per PRS_BACKGROUND_MS (a trailing fetch,
// so the last event in a burst is never lost).
export function fleetRefetchDelay(options: { pageVisible: boolean; fetchedAt: number; now: number }): number {
  if (options.pageVisible) return 0;
  return Math.max(0, options.fetchedAt + PRS_BACKGROUND_MS - options.now);
}

// The report names an agent by fleet key: `name` for the server's own agents,
// `host:name` for remote ones. Its app key is that connection's row, if it is
// still in the fleet.
export function prAgentKey(connection: string, rows: readonly Pick<AgentRow, "name" | "host">[], key: string): string | null {
  if (!key) return null;
  const row = rows.find((candidate) => agentId(candidate) === key);
  return row ? agentKey(connection, row) : null;
}

// The nudge goes after an existing draft, separated by a blank line, and is
// never added twice.
export function mergeNudge(draft: string, text: string): string {
  const kept = draft.replace(/\s+$/, "");
  if (!kept.trim()) return text;
  if (kept.endsWith(text)) return kept;
  return `${kept}\n\n${text}`;
}

// The nav badge: the PRs that need the user, when there are any.
export function needsMeCount(report: unknown): number {
  const value = (report as { counts?: { needsMe?: unknown } } | null)?.counts?.needsMe;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
