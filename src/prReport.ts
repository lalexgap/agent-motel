import type { DisplayStatus } from "./commands/ls";
import { fleetKey, type Fleet, type FleetRow } from "./fleet";
import { derivePrStatuses, PR_STATES, RECENT_MS, type PrState, type PrStatus } from "./prStatus";

// Pure over a Fleet, so it never waits on GitHub: the daemon's PR monitor keeps the inputs fresh.

export interface PrRow extends PrStatus {
  // "owner/repo#123"
  key: string;
  // Fleet key of the owning agent ("host:name" when remote).
  agent: string;
  agentName: string;
  host?: string;
  agentStatus: DisplayStatus;
  // Other agents tracking the same PR.
  alsoTrackedBy?: string[];
  // Position in a chain of dependent PRs (1 = the bottom, based on the trunk).
  stack?: { position: number; size: number; parent?: number; children: number[] };
}

export interface PrReport {
  generatedAt: string;
  prs: PrRow[];
  counts: Record<PrState, number> & { open: number; needsMe: number };
  // Agents whose last GitHub lookup failed: their rows may be stale.
  stale: string[];
  unreachable: string[];
}

export interface PrReportOptions {
  // Keep merged and closed PRs older than the recent window.
  all?: boolean;
  needsMe?: boolean;
  repo?: string;
  state?: PrState;
}

const ORDER: Record<PrState, number> = {
  "needs-decision": 0, "merge-ready": 2, conflict: 3, "ci-failing": 4, shepherding: 5, waiting: 6, merged: 7, closed: 8,
};
const rank = (pr: PrStatus) => pr.needsMe ? Math.min(1, ORDER[pr.state]) : ORDER[pr.state];
const alive = (status: DisplayStatus) => status !== "exited" && status !== "dead";

// A host on an older am sends prMonitor without prStatus: derive what the row allows.
function statuses(row: FleetRow, now: Date, all: boolean): PrStatus[] {
  const prs = row.prMonitor?.pullRequests ?? [];
  const known = row.prStatus ?? derivePrStatuses({
    prs, alive: alive(row.status), decisions: [], now,
    subagents: (row.subagents?.running ?? []).map(sub => ({ type: sub.type, description: sub.description, startedAt: sub.startedAt })),
  });
  if (!all) return known;
  const have = new Set(known.map(pr => pr.url));
  const older = prs.filter(pr => !have.has(pr.url));
  return [...known, ...derivePrStatuses({ prs: older, alive: false, decisions: [], subagents: [], now: new Date(0) })];
}

function linkStacks(rows: PrRow[]): void {
  const open = rows.filter(row => row.state !== "merged" && row.state !== "closed" && row.headRefName && row.baseRefName);
  const byHead = new Map(open.map(row => [`${row.repository.toLowerCase()}\n${row.headRefName}`, row]));
  const parent = (row: PrRow) => {
    const found = byHead.get(`${row.repository.toLowerCase()}\n${row.baseRefName}`);
    return found && found !== row ? found : undefined;
  };
  const children = new Map<PrRow, PrRow[]>();
  for (const row of open) {
    const up = parent(row);
    if (up) children.set(up, [...(children.get(up) ?? []), row]);
  }
  const depth = (row: PrRow, seen = new Set<PrRow>()): number => {
    const up = parent(row);
    return !up || seen.has(row) ? 1 : 1 + depth(up, seen.add(row));
  };
  const height = (row: PrRow, seen = new Set<PrRow>()): number => seen.has(row) ? 0 :
    1 + Math.max(0, ...(children.get(row) ?? []).map(child => height(child, new Set(seen).add(row))));
  const root = (row: PrRow, seen = new Set<PrRow>()): PrRow => {
    const up = parent(row);
    return !up || seen.has(row) ? row : root(up, seen.add(row));
  };
  for (const row of open) {
    const up = parent(row);
    const below = children.get(row) ?? [];
    if (!up && !below.length) continue;
    row.stack = { position: depth(row), size: height(root(row)), ...(up ? { parent: up.number } : {}), children: below.map(child => child.number) };
  }
}

export function buildPrReport(fleet: Fleet, now: Date = new Date(), opts: PrReportOptions = {}): PrReport {
  const byUrl = new Map<string, PrRow>();
  const stale: string[] = [];
  for (const row of fleet.rows) {
    const agent = fleetKey(row);
    if (row.prMonitor?.error && row.prMonitor.pullRequests.some(pr => pr.state === "OPEN")) stale.push(agent);
    for (const status of statuses(row, now, !!opts.all)) {
      const next: PrRow = {
        ...status, key: `${status.repository}#${status.number}`, agent, agentName: row.name,
        ...(row.host ? { host: row.host } : {}), agentStatus: row.status,
      };
      const url = status.url.toLowerCase();
      const current = byUrl.get(url);
      if (!current) { byUrl.set(url, next); continue; }
      // The agent still able to act owns the row; otherwise the fresher view.
      const wins = alive(next.agentStatus) !== alive(current.agentStatus) ? alive(next.agentStatus)
        : Date.parse(next.lastActivity) > Date.parse(current.lastActivity);
      const [keep, drop] = wins ? [next, current] : [current, next];
      keep.alsoTrackedBy = [...new Set([...(keep.alsoTrackedBy ?? []), ...(drop.alsoTrackedBy ?? []), drop.agent])].filter(name => name !== keep.agent);
      byUrl.set(url, keep);
    }
  }
  const everything = [...byUrl.values()];
  linkStacks(everything);
  const counts = Object.fromEntries([...PR_STATES.map(state => [state, 0]), ["open", 0], ["needsMe", 0]]) as PrReport["counts"];
  const cutoff = now.getTime() - RECENT_MS;
  const visible = everything.filter(row => opts.all || (row.state !== "merged" && row.state !== "closed") || Date.parse(row.since ?? row.lastActivity) >= cutoff);
  for (const row of visible) {
    counts[row.state]++;
    if (row.state !== "merged" && row.state !== "closed") counts.open++;
    if (row.needsMe) counts.needsMe++;
  }
  const repo = opts.repo?.toLowerCase();
  const prs = visible
    .filter(row => (!opts.needsMe || row.needsMe) && (!opts.state || row.state === opts.state) &&
      (!repo || row.repository.toLowerCase() === repo || row.repository.toLowerCase().endsWith(`/${repo}`)))
    .sort((a, b) => rank(a) - rank(b) || Date.parse(b.lastActivity) - Date.parse(a.lastActivity) || a.key.localeCompare(b.key));
  return { generatedAt: now.toISOString(), prs, counts, stale: [...new Set(stale)].sort(), unreachable: fleet.unreachable };
}

function age(iso: string | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso ?? "")) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function prReasonLine(pr: PrStatus, now: Date): string {
  const held = pr.since ? age(pr.since, now.getTime()) : "";
  return held ? `${pr.reason} · ${held}` : pr.reason;
}

// Finished PRs are context, not work: the text view shows the latest few.
const FINISHED_ROWS = 8;
const clipTo = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + "…" : text;

export function formatPrReport(report: PrReport, now: Date = new Date(report.generatedAt)): string[] {
  const { counts } = report;
  if (report.prs.length === 0) return [counts.open ? "No PRs match." : "No tracked PRs — agents register theirs with `am pr <agent> <url>`."];
  const head = [`${counts.open} open`, counts.needsMe ? `${counts.needsMe} need you` : "", counts["merge-ready"] ? `${counts["merge-ready"]} merge-ready` : ""]
    .filter(Boolean).join(" · ");
  const cells = report.prs.map(pr => ({
    mark: pr.needsMe ? "!" : pr.state === "merge-ready" ? "✔" : " ",
    state: pr.state,
    pr: pr.key + (pr.stack ? ` [${pr.stack.position}/${pr.stack.size}]` : ""),
    agent: pr.agent,
    reason: clipTo(prReasonLine(pr, now), 72) + (pr.readyMark?.note ? ` (${pr.readyMark.note})` : ""),
    activity: `${age(pr.lastActivity, now.getTime())} ago`,
    title: pr.title ? clipTo(pr.title, 60) : "",
  }));
  const width = (key: "state" | "pr" | "agent" | "reason") => Math.max(key.length, ...cells.map(cell => cell[key].length));
  const [state, pr, agent, reason] = [width("state"), width("pr"), width("agent"), width("reason")];
  const lines = [`PRs: ${head}`, "", `  ${"STATE".padEnd(state)}  ${"PR".padEnd(pr)}  ${"AGENT".padEnd(agent)}  ${"REASON".padEnd(reason)}  ACTIVITY  TITLE`];
  const finished = (index: number) => ["merged", "closed"].includes(report.prs[index]!.state);
  const shown = cells.filter((_cell, index) => !finished(index) || cells.slice(0, index).filter((_c, i) => finished(i)).length < FINISHED_ROWS);
  for (const cell of shown) {
    lines.push(`${cell.mark} ${cell.state.padEnd(state)}  ${cell.pr.padEnd(pr)}  ${cell.agent.padEnd(agent)}  ${cell.reason.padEnd(reason)}  ${cell.activity.padEnd(8)}  ${cell.title}`.trimEnd());
  }
  if (shown.length < cells.length) lines.push(`  … ${cells.length - shown.length} more merged or closed (am prs --json lists them all)`);
  if (report.stale.length) lines.push("", `GitHub lookup failing for: ${report.stale.join(", ")} (showing the last known state)`);
  if (report.unreachable.length) lines.push("", `Unreachable hosts: ${report.unreachable.join(", ")}`);
  return lines;
}
