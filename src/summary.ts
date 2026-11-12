import type { DisplayStatus } from "./commands/ls";
import { fleetKey, type Fleet, type FleetRow } from "./fleet";
import { formatTrackedPullRequest } from "./prMonitorDisplay";
import { buildPrReport, prReasonLine, type PrRow } from "./prReport";
import { loadConfig } from "./config";
import { flattenStoreText } from "./decisions";

export const STALE_STARTING_SECONDS = 120;
// An open decision this old gets its age shown beside it.
export const DECISION_AGE_SHOWN_SECONDS = 48 * 3600;
const DECISION_QUESTION_MAX = 80;

export type SummaryStatus = DisplayStatus | "unreachable";

export interface SummaryItem {
  key: string;
  name: string;
  host?: string;
  status: SummaryStatus;
  reason?: string;
  task?: string;
  provider?: FleetRow["provider"];
  role?: string;
  queued: number;
  changedAt?: string;
  ageSeconds: number;
  dir?: string;
  prMonitor?: FleetRow["prMonitor"];
  // Open questions in the agent's decisions store, when it has any.
  decisions?: { open: number; blocking: number; oldestAskedAt?: string; first?: string };
}

export interface FleetSummary {
  generatedAt: string;
  totalAgents: number;
  unreachableHosts: number;
  attention: SummaryItem[];
  active: SummaryItem[];
  idle: SummaryItem[];
  exited: SummaryItem[];
  // Agents with at least one open decision waiting on the operator.
  waitingOnDecisions: number;
  // This host's last scheduled gc, in a line (see autoGc.ts).
  gc?: string;
  // PRs waiting on the operator, then the ones ready to merge (see `am prs`).
  prs?: { needsMe: SummaryPr[]; mergeReady: SummaryPr[] };
}

export interface SummaryPr {
  key: string;
  url: string;
  agent: string;
  state: PrRow["state"];
  // The reason with how long it has held: "needs decision: ship the flag? · 2h".
  reason: string;
}

function ageSeconds(iso: string | undefined, nowMs: number): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 1000)) : 0;
}

function shortTask(task: string | undefined, max = 80): string | undefined {
  const first = task?.split("\n")[0]?.trim();
  if (!first) return undefined;
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

function oneLine(text: string, max: number): string {
  const flat = flattenStoreText(text);
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

// "waiting on 2 decisions from you: <first question> (open 3d)". Pure.
export function decisionsReason(decisions: NonNullable<SummaryItem["decisions"]>, nowMs: number): string {
  const noun = `${decisions.open} decision${decisions.open === 1 ? "" : "s"}`;
  const first = decisions.first ? `: ${oneLine(decisions.first, DECISION_QUESTION_MAX)}` : "";
  const age = ageSeconds(decisions.oldestAskedAt, nowMs);
  const open = decisions.oldestAskedAt && age >= DECISION_AGE_SHOWN_SECONDS ? ` (open ${formatAge(age)})` : "";
  return `waiting on ${noun} from you${first}${open}`;
}

function rowDecisions(row: FleetRow): SummaryItem["decisions"] {
  if (!row.openDecisions || row.openDecisions <= 0) return undefined;
  return {
    open: row.openDecisions,
    blocking: row.blockingDecisions ?? 0,
    ...(row.oldestDecisionAt ? { oldestAskedAt: row.oldestDecisionAt } : {}),
    ...(row.firstDecision ? { first: row.firstDecision } : {}),
  };
}

function decisionsShown(): boolean {
  try {
    return loadConfig().decisions !== false;
  } catch {
    return true;
  }
}

function summaryItem(row: FleetRow, nowMs: number): SummaryItem {
  const changedAt = row.statusChangedAt ?? row.updatedAt;
  const age = ageSeconds(changedAt, nowMs);
  let reason = row.status === "waiting" ? row.statusDetail : row.statusReason;
  if (row.status === "dead") reason = "tmux session is missing";
  if (row.status === "needs-attention" && !reason) reason = "agent requested attention";
  if (row.status === "starting" && age >= STALE_STARTING_SECONDS) {
    reason = `still starting after ${formatAge(age)}`;
  }
  return {
    key: fleetKey(row),
    name: row.name,
    ...(row.host ? { host: row.host } : {}),
    status: row.status,
    ...(reason ? { reason } : {}),
    ...(shortTask(row.task) ? { task: shortTask(row.task) } : {}),
    provider: row.provider,
    ...(row.role ? { role: row.role } : {}),
    queued: row.queued,
    changedAt,
    ageSeconds: age,
    dir: row.dir,
    ...(row.prMonitor ? { prMonitor: row.prMonitor } : {}),
  };
}

function itemPriority(item: SummaryItem): number {
  if (item.status === "needs-attention") return 0;
  if (item.status === "unreachable") return 1;
  if (item.status === "dead") return 2;
  if (item.status === "starting") return 3;
  if (item.status === "working") return 4;
  if (item.status === "waiting") return 5;
  return 6;
}

function sortItems(items: SummaryItem[]): SummaryItem[] {
  return items.sort((a, b) => itemPriority(a) - itemPriority(b) || a.key.localeCompare(b.key));
}

export function buildFleetSummary(
  fleet: Fleet,
  now: Date = new Date(),
  gc?: string | null,
  opts: { decisions?: boolean } = {},
): FleetSummary {
  const nowMs = now.getTime();
  const showDecisions = opts.decisions ?? decisionsShown();
  const summary: FleetSummary = {
    generatedAt: now.toISOString(),
    totalAgents: fleet.rows.length,
    unreachableHosts: fleet.unreachable.length,
    attention: [],
    active: [],
    idle: [],
    exited: [],
    waitingOnDecisions: 0,
  };

  for (const row of fleet.rows) {
    const item = summaryItem(row, nowMs);
    const staleStarting = row.status === "starting" && item.ageSeconds >= STALE_STARTING_SECONDS;
    const decisions = showDecisions ? rowDecisions(row) : undefined;
    if (decisions) {
      // One row per agent: an agent already flagged for another reason keeps
      // it, with the decisions after.
      item.decisions = decisions;
      item.reason = [item.reason, decisionsReason(decisions, nowMs)].filter(Boolean).join("; ");
      summary.waitingOnDecisions += 1;
    }
    if (row.status === "needs-attention" || row.status === "dead" || staleStarting || decisions) {
      summary.attention.push(item);
    } else if (row.status === "working" || row.status === "waiting" || row.status === "starting") {
      summary.active.push(item);
    } else if (row.status === "idle") {
      summary.idle.push(item);
    } else {
      summary.exited.push(item);
    }
  }

  for (const host of fleet.unreachable) {
    summary.attention.push({
      key: `${host}:`,
      name: host,
      host,
      status: "unreachable",
      reason: "remote host unavailable",
      queued: 0,
      ageSeconds: 0,
    });
  }

  if (gc) summary.gc = gc;
  const brief = (pr: PrRow): SummaryPr => ({ key: pr.key, url: pr.url, agent: pr.agent, state: pr.state, reason: prReasonLine(pr, now) });
  const prs = buildPrReport(fleet, now).prs;
  const needsMe = prs.filter((pr) => pr.needsMe).map(brief);
  const mergeReady = prs.filter((pr) => pr.state === "merge-ready" && !pr.needsMe).map(brief);
  if (needsMe.length || mergeReady.length) summary.prs = { needsMe, mergeReady };
  sortItems(summary.attention);
  sortItems(summary.active);
  sortItems(summary.idle);
  sortItems(summary.exited);
  return summary;
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function section(title: string, items: SummaryItem[], nameWidth: number): string[] {
  if (items.length === 0) return [];
  const lines = [`${title} (${items.length})`];
  for (const item of items) {
    const detail = item.reason ?? item.task;
    const queued = item.queued > 0 ? ` · ${item.queued} queued` : "";
    const age = item.status === "unreachable" ? "" : `  ${formatAge(item.ageSeconds)}`;
    const role = item.role ? ` · ${item.role}` : "";
    const prs = item.prMonitor?.pullRequests.map(formatTrackedPullRequest).join(" · ");
    lines.push(`  ${item.key.padEnd(nameWidth)} ${item.status}${role}${detail ? ` — ${detail}` : ""}${prs ? ` · ${prs}` : ""}${queued}${age}`);
  }
  return lines;
}

function prSection(title: string, prs: SummaryPr[] | undefined): string[] {
  if (!prs?.length) return [];
  return ["", `${title} (${prs.length})`, ...prs.map((pr) => `  ${pr.key} — ${pr.reason} (${pr.agent})`)];
}

export function formatFleetSummary(summary: FleetSummary): string[] {
  if (summary.totalAgents === 0 && summary.unreachableHosts === 0) return ["No agents.", ...(summary.gc ? ["", `gc: ${summary.gc}`] : [])];
  // Historical agents can number in the hundreds. Keep the default report
  // focused on current work and queued PR follow-ups; JSON retains all exits.
  const queuedExits = summary.exited.filter((item) => item.queued > 0 && item.prMonitor?.pullRequests.length);
  const visible = [...summary.attention, ...summary.active, ...summary.idle, ...queuedExits];
  const nameWidth = Math.max(4, ...visible.map((item) => item.key.length));
  const unreachable = summary.unreachableHosts > 0
    ? ` · ${plural(summary.unreachableHosts, "unreachable host")}`
    : "";
  const decisions = summary.waitingOnDecisions > 0
    ? ` · ${plural(summary.waitingOnDecisions, "agent")} waiting on decisions`
    : "";
  const lines = [`Fleet: ${plural(summary.totalAgents, "agent")}${unreachable}${decisions}`];
  for (const [title, items] of [
    ["Needs attention", summary.attention],
    ["Active", summary.active],
    ["Idle", summary.idle],
    ["Exited with queued messages", queuedExits],
  ] as const) {
    const rendered = section(title, items, nameWidth);
    if (rendered.length > 0) lines.push("", ...rendered);
    if (title === "Needs attention") lines.push(...prSection("PRs needing you", summary.prs?.needsMe), ...prSection("PRs merge-ready", summary.prs?.mergeReady));
  }
  const hiddenExits = summary.exited.length - queuedExits.length;
  if (hiddenExits > 0) lines.push("", `Exited (${hiddenExits})`);
  if (summary.gc) lines.push("", `gc: ${summary.gc}`);
  return lines;
}
