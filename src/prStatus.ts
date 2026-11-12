import type { OpenDecision } from "./decisions";
import { checksVerdict, type PrChecks, type TrackedPullRequest } from "./prMonitor";

// Derived on the agent's own host, where the subagent ledger and decisions store live.

export type PrState = "needs-decision" | "merge-ready" | "conflict" | "ci-failing" | "shepherding" | "waiting" | "merged" | "closed";

export const PR_STATES: PrState[] = ["needs-decision", "merge-ready", "conflict", "ci-failing", "shepherding", "waiting", "merged", "closed"];

export interface PrStatus {
  repository: string;
  number: number;
  url: string;
  title?: string;
  state: PrState;
  // One line, without a relative time: clients append one from `since`.
  reason: string;
  // When `state` began, where the evidence carries a time.
  since?: string;
  needsMe: boolean;
  // Open, and its agent is exited or dead: nobody is driving it.
  orphaned?: boolean;
  lastActivity: string;
  draft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  headSha?: string;
  checks?: PrChecks;
  reviewDecision?: TrackedPullRequest["reviewDecision"];
  shepherd?: { state: "running" | "waiting" | "ready" | "not-ready"; note?: string; at: string };
  decision?: { id: string; question: string; blocking: boolean; link?: string; more?: number };
  // `am pr --ready` evidence, and where it disagrees with what was derived.
  readyMark?: { at?: string; current: boolean; note?: string };
}

// The slice of a subagent ledger record the derivation reads; a row's running
// subagents satisfy it too, which is the fallback for hosts without prStatus.
export interface PrSubagent {
  type: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  message?: string;
  // "turn": swept up by the parent's turn boundary, so it never reported.
  endedBy?: "stop" | "turn";
  // Still open in the ledger but showing no sign of life.
  quiet?: boolean;
}

export interface PrStatusInput {
  prs: TrackedPullRequest[];
  // The agent can still act on its PRs (not exited, not dead).
  alive: boolean;
  subagents: PrSubagent[];
  decisions: OpenDecision[];
  now: Date;
}

export const RECENT_MS = 72 * 3600_000;
// A stopped shepherd with no verdict is between wake-ups, not finished.
const SHEPHERD_WAIT_MS = 30 * 60_000;

function prNumbers(text: string | undefined): number[] {
  return [...(text ?? "").matchAll(/(?:\bPR\s*#?|#)(\d{1,7})\b/gi)].map(match => Number(match[1]));
}

const isShepherd = (sub: PrSubagent) => sub.type.toLowerCase() === "shepherd" || /shepherd/i.test(sub.description ?? "");
const isReviewer = (sub: PrSubagent) => /^reviewer/i.test(sub.type) || /\breview/i.test(sub.description ?? "");

// A subagent that names no PR can only be attributed when the agent has one open PR.
function concerns(sub: PrSubagent, number: number, sole: boolean): boolean {
  const named = prNumbers(sub.description);
  if (named.length) return named.includes(number);
  const said = isShepherd(sub) ? prNumbers(sub.message) : [];
  return said.length ? said.includes(number) : sole;
}

const plain = (text: string | undefined) => text?.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

export function shepherdVerdict(message: string | undefined): "ready" | "not-ready" | undefined {
  if (!message) return undefined;
  if (/\bnot (?:yet )?(?:merge[- ])?ready\b|\bisn['’]t (?:yet )?(?:merge[- ])?ready\b|\bno (?:readiness )?verdict\b|\bblocked\b/i.test(message)) return "not-ready";
  return /\bmerge[- ]ready\b|\bready to merge\b/i.test(message) ? "ready" : undefined;
}

function shepherdFor(pr: TrackedPullRequest, input: PrStatusInput, sole: boolean): PrStatus["shepherd"] {
  const mine = input.subagents.filter(sub => concerns(sub, pr.number, sole));
  const latest = mine.filter(isShepherd).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (!latest) return undefined;
  if (!latest.endedAt) return input.alive && !latest.quiet ? { state: "running", note: latest.description, at: latest.startedAt } : undefined;
  const verdict = shepherdVerdict(latest.message);
  const headSeen = Date.parse(pr.headSince ?? "");
  const namesHead = !!pr.headSha && (latest.message ?? "").includes(pr.headSha.slice(0, 7));
  const stale = Number.isFinite(headSeen) && Date.parse(latest.endedAt) < headSeen && !namesHead;
  if (verdict && !stale) return { state: verdict, note: plain(latest.message), at: latest.endedAt };
  const helpers = mine.some(sub => !sub.endedAt && !sub.quiet && !isShepherd(sub));
  const fresh = latest.endedBy !== "turn" && input.now.getTime() - Date.parse(latest.endedAt) < SHEPHERD_WAIT_MS;
  if (!verdict && input.alive && (helpers || fresh)) return { state: "waiting", note: plain(latest.message ?? latest.description), at: latest.endedAt };
  return undefined;
}

function checksLine(checks: PrChecks): string {
  const names = checks.failing.slice(0, 3).join(", ");
  return `CI failing: ${names}${checks.failing.length > 3 ? ` +${checks.failing.length - 3}` : ""}`;
}

function later(...times: (string | undefined)[]): string | undefined {
  return times.filter((time): time is string => Number.isFinite(Date.parse(time ?? ""))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function derive(pr: TrackedPullRequest, input: PrStatusInput, sole: boolean): PrStatus {
  const base: Omit<PrStatus, "state" | "reason" | "needsMe"> = {
    repository: pr.repository, number: pr.number, url: pr.url, lastActivity: pr.updatedAt,
    ...(pr.title ? { title: pr.title } : {}), ...(pr.draft !== undefined ? { draft: pr.draft } : {}),
    ...(pr.baseRefName ? { baseRefName: pr.baseRefName } : {}), ...(pr.headRefName ? { headRefName: pr.headRefName } : {}),
    ...(pr.headSha ? { headSha: pr.headSha } : {}), ...(pr.checks ? { checks: pr.checks } : {}),
    ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
  };
  if (pr.state === "MERGED") {
    return { ...base, state: "merged", reason: `merged${pr.mergeCommit ? ` at ${pr.mergeCommit.slice(0, 7)}` : ""}`, since: pr.mergedAt, needsMe: false };
  }
  if (pr.state === "CLOSED") return { ...base, state: "closed", reason: "closed without merging", since: pr.closedAt, needsMe: false };

  const orphaned = !input.alive;
  const target = pr.baseRefName ?? "its base";
  const ci = checksVerdict(pr.checks);
  const conflict = pr.mergeable === "CONFLICTING" || (pr.mergeable !== "MERGEABLE" && pr.conflictActive === true);
  const blocker = conflict ? `conflicts with ${target}` : ci === "failing" ? checksLine(pr.checks!) : ci === "pending" ? "CI running" : undefined;
  const shepherd = shepherdFor(pr, input, sole);
  const marked = pr.readyNotifiedHead !== undefined;
  const markCurrent = marked && pr.readyNotifiedHead === pr.headSha;
  const green = pr.mergeable === "MERGEABLE" && (ci === "passing" || ci === "none") && pr.reviewDecision !== "CHANGES_REQUESTED" &&
    pr.mergeStateStatus !== "BEHIND" && pr.mergeStateStatus !== "DIRTY";
  const decisions = input.decisions
    .filter(decision => decision.prs.length ? decision.prs.some(url => url.toLowerCase() === pr.url.toLowerCase()) : sole)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const decision = decisions[0];

  let state: PrState;
  let reason: string;
  let since: string | undefined;
  if (decision) {
    state = "needs-decision"; reason = `needs decision: ${decision.question}`; since = decision.askedAt;
  } else if (shepherd?.state === "running" || shepherd?.state === "waiting") {
    state = "shepherding"; since = shepherd.at;
    reason = (shepherd.state === "running" ? "shepherd running" : `shepherd: ${shepherd.note ?? "between checks"}`) + (blocker ? ` · ${blocker}` : "");
  } else if (conflict) {
    state = "conflict"; reason = blocker!; since = pr.conflictSince;
  } else if (ci === "failing") {
    state = "ci-failing"; reason = blocker!; since = pr.checksSince;
  } else if (green && (shepherd?.state === "ready" || markCurrent)) {
    state = "merge-ready";
    reason = `merge-ready: ${ci === "none" ? "no CI checks" : "CI green"}, ${shepherd?.state === "ready" ? "shepherd verdict" : "am pr --ready"}`;
    since = later(shepherd?.state === "ready" ? shepherd.at : pr.readyNotifiedAt, pr.checksSince);
  } else {
    state = "waiting";
    if (ci === "pending") { reason = `CI running (${pr.checks!.pending} pending)`; since = pr.checksSince; }
    else if (pr.reviewDecision === "CHANGES_REQUESTED") reason = "changes requested in review";
    else if (pr.mergeStateStatus === "BEHIND") reason = `behind ${target}`;
    else if (shepherd?.state === "not-ready") { reason = `shepherd: ${shepherd.note}`; since = shepherd.at; }
    else if (pr.mergeable !== "MERGEABLE") reason = "GitHub is still computing mergeability";
    else if (marked && !markCurrent) reason = "head moved since it was marked ready; needs re-review";
    else if (input.subagents.some(sub => !sub.endedAt && !sub.quiet && isReviewer(sub) && concerns(sub, pr.number, sole))) reason = "review running";
    else if (input.alive && input.subagents.some(sub => !sub.endedAt && sub.quiet && isShepherd(sub) && concerns(sub, pr.number, sole))) reason = "shepherd has gone quiet";
    else reason = `${ci === "none" ? "no CI checks" : "CI green"}, no review verdict yet`;
  }

  const readyMark: PrStatus["readyMark"] = marked ? {
    current: markCurrent, ...(pr.readyNotifiedAt ? { at: pr.readyNotifiedAt } : {}),
    ...(!markCurrent ? { note: "ready mark is for an older head" }
      : state !== "merge-ready" && state !== "needs-decision" ? { note: "marked ready, but its current state disagrees" } : {}),
  } : state === "merge-ready" ? { current: false, note: "not marked with am pr --ready" } : undefined;

  return {
    ...base, state, reason: orphaned ? `${reason} · agent not running` : reason, ...(since ? { since } : {}),
    needsMe: state === "needs-decision" || orphaned, ...(orphaned ? { orphaned } : {}),
    ...(shepherd ? { shepherd: { ...shepherd, ...(shepherd.note ? { note: shepherd.note.slice(0, 200) } : {}) } } : {}),
    ...(decision ? { decision: { id: decision.id, question: decision.question, blocking: decision.blocking,
      ...(decision.link ? { link: decision.link } : {}), ...(decisions.length > 1 ? { more: decisions.length - 1 } : {}) } } : {}),
    ...(readyMark ? { readyMark } : {}),
  };
}

function recent(pr: TrackedPullRequest, now: Date): boolean {
  if (pr.state === "OPEN") return true;
  const at = Date.parse(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt);
  return Number.isFinite(at) && now.getTime() - at < RECENT_MS;
}

// Open PRs plus recently merged or closed ones. Pure.
export function derivePrStatuses(input: PrStatusInput): PrStatus[] {
  const sole = input.prs.filter(pr => pr.state === "OPEN").length === 1;
  return input.prs.filter(pr => recent(pr, input.now)).map(pr => derive(pr, input, sole));
}

export function hasRecentPullRequests(prs: TrackedPullRequest[] | undefined, now: Date): boolean {
  return !!prs?.some(pr => recent(pr, now));
}
