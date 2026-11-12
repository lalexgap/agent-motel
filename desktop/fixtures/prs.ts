// Tracked pull requests for GET /api/prs, over the fixture fleet. Every repo,
// title and decision here is invented. The report follows buildPrReport in
// src/prReport.ts: one row per PR, owned by a fleet agent, sorted by state with
// the ones that need the user first; merged and closed PRs older than the
// recent window only with all=1; counts before the needsMe/state/repo filters.
import type { FixtureRow } from "./data";

export const PR_STATES = ["needs-decision", "merge-ready", "conflict", "ci-failing", "shepherding", "waiting", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];
const RECENT_MS = 72 * 3600_000;
const ORDER: Record<PrState, number> = {
  "needs-decision": 0, "merge-ready": 2, conflict: 3, "ci-failing": 4, shepherding: 5, waiting: 6, merged: 7, closed: 8,
};

export interface FixturePr {
  repository: string;
  number: number;
  url: string;
  title: string;
  state: PrState;
  reason: string;
  since?: string;
  needsMe: boolean;
  orphaned?: boolean;
  lastActivity: string;
  draft: boolean;
  baseRefName: string;
  headRefName: string;
  checks?: { total: number; pending: number; failing: string[] };
  reviewDecision?: string;
  shepherd?: { state: "running" | "waiting" | "ready" | "not-ready"; note?: string; at: string };
  decision?: { id: string; question: string; blocking: boolean; link?: string; more?: number };
  readyMark?: { at?: string; current: boolean; note?: string };
  // Fixture-only: set by the seed, the real server derives them.
  alsoTrackedBy?: string[];
  stack?: { position: number; size: number; parent?: number; children: number[] };
}
export interface AgentPrs {
  prs: FixturePr[];
  // Its last GitHub lookup failed: its rows may be stale.
  stale?: boolean;
}

interface Seed extends Omit<FixturePr, "url" | "since" | "lastActivity" | "draft" | "baseRefName" | "headRefName" | "shepherd" | "readyMark"> {
  // Minutes ago.
  sinceMin?: number;
  activityMin: number;
  draft?: boolean;
  base?: string;
  head: string;
  shepherd?: { state: "running" | "waiting" | "ready" | "not-ready"; note?: string; atMin: number };
  readyMark?: { atMin?: number; current: boolean; note?: string };
}
const LIGHTHOUSE = "example/lighthouse";
const PAPER_CRANE = "example/paper-crane";
const TIDE_TABLES = "example/tide-tables";
const DAY = 24 * 60;

// By agent fleet key (`host:name` for remote agents).
const SEEDS: Record<string, { prs: Seed[]; stale?: boolean }> = {
  "fog-signal": {
    prs: [{
      repository: LIGHTHOUSE, number: 131, title: "[Schedule] Store lamp times with their timezone", state: "needs-decision",
      reason: "needs decision: Migrate the schedule rows in place, or backfill a new column?", sinceMin: 4, needsMe: true, activityMin: 4,
      head: "am/fog-signal", checks: { total: 7, pending: 0, failing: [] },
      decision: {
        id: "d-7", question: "Migrate the existing schedule rows in place, or backfill a new column and switch over once it is filled?", blocking: true,
        link: "https://github.com/example/lighthouse/pull/131", more: 1,
      },
    }],
  },
  "old-lens": {
    prs: [{
      repository: LIGHTHOUSE, number: 119, title: "[Renderer] Draw the beacon with SVG sprites", state: "ci-failing",
      reason: "CI failing: unit, visual · agent not running", sinceMin: 290, needsMe: true, orphaned: true, activityMin: 300,
      head: "am/old-lens", checks: { total: 7, pending: 0, failing: ["unit", "visual"] },
    }],
  },
  "crease-check": {
    prs: [
      {
        repository: PAPER_CRANE, number: 102, title: "[Export] Tag PDF headings for screen readers", state: "merge-ready",
        reason: "merge-ready: CI green, shepherd verdict", sinceMin: 30, needsMe: false, activityMin: 26,
        head: "am/crease-check", checks: { total: 5, pending: 0, failing: [] },
        shepherd: { state: "ready", note: "PR #102 is merge-ready. It is still a draft.", atMin: 30 },
        readyMark: { current: false, note: "not marked with am pr --ready" },
      },
      {
        repository: PAPER_CRANE, number: 97, title: "[Export] Export a folding plan as PDF", state: "merged", reason: "merged at 9e1d4b2",
        sinceMin: 4 * DAY, needsMe: false, activityMin: 4 * DAY, draft: false, head: "am/pdf-export",
      },
    ],
  },
  "tide-pilot": {
    prs: [{
      repository: TIDE_TABLES, number: 73, title: "[API] Send Retry-After with every 503", state: "conflict", reason: "conflicts with main",
      sinceMin: 9, needsMe: false, activityMin: 0.4, head: "am/tide-pilot", checks: { total: 0, pending: 0, failing: [] }, alsoTrackedBy: ["ebb-report"],
    }],
  },
  "harbor-lights": {
    prs: [
      {
        repository: LIGHTHOUSE, number: 127, title: "[Sync] Give the beacon sync worker a retry budget", state: "shepherding",
        reason: "shepherd running · CI running", sinceMin: 12, needsMe: false, activityMin: 2, head: "am/harbor-lights",
        checks: { total: 7, pending: 4, failing: [] }, shepherd: { state: "running", note: "Shepherd PR 127", atMin: 12 },
        stack: { position: 1, size: 2, children: [128] },
      },
      {
        repository: LIGHTHOUSE, number: 128, title: "[Status] Report each station's sync state", state: "waiting",
        reason: "waiting on review", sinceMin: 6, needsMe: false, activityMin: 3, base: "am/harbor-lights", head: "am/harbor-lights-status",
        checks: { total: 7, pending: 0, failing: [] }, stack: { position: 2, size: 2, parent: 127, children: [] },
      },
    ],
  },
  "drift-net": {
    prs: [{
      repository: LIGHTHOUSE, number: 125, title: "[CI] Quarantine the flaky lens-cleaning tests", state: "waiting", reason: "CI running (2 pending)",
      sinceMin: 1, needsMe: false, activityMin: 0.5, head: "am/drift-net", checks: { total: 7, pending: 2, failing: [] },
    }],
  },
  "annex:kelp-forest": {
    prs: [{
      repository: TIDE_TABLES, number: 64, title: "[Predict] Cache constituent phases per day", state: "shepherding",
      reason: "shepherd: Main reviewer done. Waiting on the security reviewer.", sinceMin: 3, needsMe: false, activityMin: 0.3,
      head: "am/kelp-forest", checks: { total: 6, pending: 0, failing: [] },
      shepherd: { state: "waiting", note: "Main reviewer done. Waiting on the security reviewer.", atMin: 3 },
    }],
  },
  "annex:sandbar": {
    stale: true,
    prs: [{
      repository: LIGHTHOUSE, number: 134, title: "[Firmware] Bump the beacon SDK to 4.0", state: "waiting",
      reason: "head moved since it was marked ready; needs re-review", needsMe: false, activityMin: 15, draft: false, head: "am/sandbar",
      checks: { total: 7, pending: 0, failing: [] }, reviewDecision: "REVIEW_REQUIRED",
      readyMark: { atMin: 95, current: false, note: "ready mark is for an older head" },
    }],
  },
  "paper-trail": {
    prs: [{
      repository: PAPER_CRANE, number: 88, title: "[Changelog] Backfill the missing 2.x entries", state: "closed", reason: "closed without merging",
      sinceMin: 6 * DAY, needsMe: false, activityMin: 6 * DAY, head: "am/paper-trail",
    }],
  },
};

const fleetKey = (row: Pick<FixtureRow, "name" | "host">) => (row.host ? `${row.host}:${row.name}` : row.name);

export function seedPrs(rows: readonly FixtureRow[], now = Date.now()): Map<FixtureRow, AgentPrs> {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const out = new Map<FixtureRow, AgentPrs>();
  for (const row of rows) {
    const seed = SEEDS[fleetKey(row)];
    if (!seed) continue;
    out.set(row, {
      stale: seed.stale,
      prs: seed.prs.map(({ sinceMin, activityMin, draft, base, head, shepherd, readyMark, ...pr }) => ({
        ...pr,
        url: `https://github.com/${pr.repository}/pull/${pr.number}`,
        ...(sinceMin === undefined ? {} : { since: ago(sinceMin) }),
        lastActivity: ago(activityMin),
        draft: draft ?? true,
        baseRefName: base ?? "main",
        headRefName: head,
        ...(shepherd ? { shepherd: { state: shepherd.state, ...(shepherd.note ? { note: shepherd.note } : {}), at: ago(shepherd.atMin) } } : {}),
        ...(readyMark ? { readyMark: { ...(readyMark.atMin === undefined ? {} : { at: ago(readyMark.atMin) }), current: readyMark.current, ...(readyMark.note ? { note: readyMark.note } : {}) } } : {}),
      })),
    });
  }
  return out;
}

export interface PrReportOptions {
  all?: boolean;
  needsMe?: boolean;
  repo?: string;
  state?: PrState;
}

const finished = (state: PrState) => state === "merged" || state === "closed";
const rank = (pr: FixturePr) => (pr.needsMe ? Math.min(1, ORDER[pr.state]) : ORDER[pr.state]);

export function prReport(rows: readonly FixtureRow[], tracked: Map<FixtureRow, AgentPrs>, unreachable: string[], opts: PrReportOptions = {}, now = new Date()) {
  const everything = [];
  const stale: string[] = [];
  for (const row of rows) {
    const entry = tracked.get(row);
    if (!entry) continue;
    const agent = fleetKey(row);
    if (entry.stale && entry.prs.some((pr) => !finished(pr.state))) stale.push(agent);
    for (const pr of entry.prs) {
      everything.push({ ...pr, key: `${pr.repository}#${pr.number}`, agent, agentName: row.name, ...(row.host ? { host: row.host } : {}), agentStatus: row.status });
    }
  }
  const counts: Record<string, number> = Object.fromEntries([...PR_STATES.map((state) => [state, 0]), ["open", 0], ["needsMe", 0]]);
  const cutoff = now.getTime() - RECENT_MS;
  const visible = everything.filter((pr) => opts.all || !finished(pr.state) || Date.parse(pr.since ?? pr.lastActivity) >= cutoff);
  for (const pr of visible) {
    counts[pr.state]!++;
    if (!finished(pr.state)) counts.open!++;
    if (pr.needsMe) counts.needsMe!++;
  }
  const repo = opts.repo?.toLowerCase();
  const prs = visible
    .filter((pr) => (!opts.needsMe || pr.needsMe) && (!opts.state || pr.state === opts.state) &&
      (!repo || pr.repository.toLowerCase() === repo || pr.repository.toLowerCase().endsWith(`/${repo}`)))
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.lastActivity) - Date.parse(a.lastActivity) || a.key.localeCompare(b.key));
  return { generatedAt: now.toISOString(), prs, counts, stale: [...new Set(stale)].sort(), unreachable };
}
