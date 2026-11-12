import { describe, expect, test } from "bun:test";
import type { OpenDecision } from "../src/decisions";
import type { TrackedPullRequest } from "../src/prMonitor";
import { derivePrStatuses, shepherdVerdict, type PrStatusInput, type PrSubagent } from "../src/prStatus";

const NOW = new Date("2026-07-22T12:00:00Z");
const HEAD = "a".repeat(40);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function pr(overrides: Partial<TrackedPullRequest> = {}): TrackedPullRequest {
  return {
    repository: "owner/repo", number: 7, url: "https://github.com/owner/repo/pull/7", state: "OPEN", updatedAt: ago(10),
    title: "Add the thing", draft: true, baseRefName: "main", headRefName: "am/thing", headSha: HEAD, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", checks: { total: 2, pending: 0, failing: [] }, checksSince: ago(20), ...overrides,
  };
}
function status(prs: TrackedPullRequest[], input: Partial<PrStatusInput> = {}) {
  return derivePrStatuses({ prs, alive: true, subagents: [], decisions: [], now: NOW, ...input });
}
const shepherd = (overrides: Partial<PrSubagent> = {}): PrSubagent => ({ type: "shepherd", description: "Shepherd PR 7", startedAt: ago(30), ...overrides });
const decision = (overrides: Partial<OpenDecision> = {}): OpenDecision => ({ id: "d-1", question: "Hold near-copies?", blocking: false, askedAt: ago(120), prs: [], ...overrides });

describe("PR status derivation", () => {
  test("a green PR is only merge-ready with review evidence, and says which", () => {
    expect(status([pr()])[0]).toMatchObject({ state: "waiting", reason: "CI green, no review verdict yet", needsMe: false });
    const verdict = status([pr()], { subagents: [shepherd({ endedAt: ago(5), message: "**Verdict: merge-ready.** Still a draft." })] })[0]!;
    expect(verdict).toMatchObject({ state: "merge-ready", reason: "merge-ready: CI green, shepherd verdict", since: ago(5) });
    expect(verdict.readyMark).toEqual({ current: false, note: "not marked with am pr --ready" });
    const marked = status([pr({ readyNotifiedHead: HEAD, readyNotifiedAt: ago(3), checks: { total: 0, pending: 0, failing: [] } })])[0]!;
    expect(marked).toMatchObject({ state: "merge-ready", reason: "merge-ready: no CI checks, am pr --ready", readyMark: { current: true, at: ago(3) } });
  });

  test("a ready mark that no longer holds is reported, not trusted", () => {
    const moved = status([pr({ readyNotifiedHead: "b".repeat(40) })])[0]!;
    expect(moved).toMatchObject({ state: "waiting", reason: "head moved since it was marked ready; needs re-review" });
    expect(moved.readyMark).toMatchObject({ current: false, note: "ready mark is for an older head" });
    const failing = status([pr({ readyNotifiedHead: HEAD, checks: { total: 3, pending: 0, failing: ["rspec", "lint"] } })])[0]!;
    expect(failing).toMatchObject({ state: "ci-failing", reason: "CI failing: rspec, lint", since: ago(20) });
    expect(failing.readyMark?.note).toBe("marked ready, but its current state disagrees");
  });

  test("a shepherd verdict given before the current head is ignored", () => {
    const stale = status([pr({ headSince: ago(10) })], { subagents: [shepherd({ endedAt: ago(60), message: "PR #7 is **merge-ready**." })] })[0]!;
    expect(stale.state).toBe("waiting");
    const justBefore = status([pr({ headSince: ago(10) })], { subagents: [shepherd({ endedAt: ago(12), message: "PR #7 is **merge-ready**." })] })[0]!;
    expect(justBefore.state).toBe("waiting");
    const namesHead = status([pr({ headSince: ago(10) })], { subagents: [shepherd({ endedAt: ago(12), message: `PR #7 is merge-ready at ${HEAD.slice(0, 7)}.` })] })[0]!;
    expect(namesHead.state).toBe("merge-ready");
  });

  test("shepherding covers a running shepherd and one between wake-ups, with the blocker it is working on", () => {
    expect(status([pr({ mergeable: "CONFLICTING", conflictSince: ago(120) })], { subagents: [shepherd()] })[0])
      .toMatchObject({ state: "shepherding", reason: "shepherd running · conflicts with main", since: ago(30) });
    const waiting = shepherd({ endedAt: ago(4), message: "Waiting on the security specialist." });
    expect(status([pr()], { subagents: [waiting] })[0]).toMatchObject({ state: "shepherding", reason: "shepherd: Waiting on the security specialist." });
    const old = shepherd({ endedAt: ago(90), message: "Waiting on the security specialist." });
    expect(status([pr()], { subagents: [old] })[0]!.state).toBe("waiting");
    const reviewer: PrSubagent = { type: "reviewer", description: "Main review PR 7", startedAt: ago(80) };
    expect(status([pr()], { subagents: [old, reviewer] })[0]!.state).toBe("shepherding");
    expect(status([pr()], { subagents: [shepherd()], alive: false })[0]!.state).toBe("waiting");
  });

  test("subagents are matched to their own PR, and unlabelled ones only when there is a single open PR", () => {
    const other = pr({ number: 8, url: "https://github.com/owner/repo/pull/8" });
    const both = status([pr(), other], { subagents: [shepherd({ description: "Shepherd PR 8" })] });
    expect(both.map(item => item.state)).toEqual(["waiting", "shepherding"]);
    const unlabelled = shepherd({ description: undefined });
    expect(status([pr(), other], { subagents: [unlabelled] }).map(item => item.state)).toEqual(["waiting", "waiting"]);
    expect(status([pr()], { subagents: [unlabelled] })[0]!.state).toBe("shepherding");
    expect(status([pr(), other], { subagents: [shepherd({ description: undefined, endedAt: ago(1), message: "PR #8: waiting on CI." })] })
      .map(item => item.state)).toEqual(["waiting", "shepherding"]);
  });

  test("an open decision outranks everything and needs the operator", () => {
    const tagged = decision({ prs: ["https://github.com/Owner/Repo/pull/7"], blocking: true });
    const result = status([pr({ mergeable: "CONFLICTING" })], { subagents: [shepherd()], decisions: [decision({ id: "d-2", prs: ["https://github.com/owner/repo/pull/7"] }), tagged] })[0]!;
    expect(result).toMatchObject({ state: "needs-decision", reason: "needs decision: Hold near-copies?", needsMe: true, since: ago(120) });
    expect(result.decision).toEqual({ id: "d-1", question: "Hold near-copies?", blocking: true, more: 1 });
    const other = pr({ number: 8, url: "https://github.com/owner/repo/pull/8" });
    expect(status([pr(), other], { decisions: [decision()] }).map(item => item.state)).toEqual(["waiting", "waiting"]);
    expect(status([pr()], { decisions: [decision()] })[0]!.state).toBe("needs-decision");
    expect(status([pr(), other], { decisions: [decision({ prs: [other.url] })] }).map(item => item.needsMe)).toEqual([false, true]);
  });

  test("blockers read in order: conflict, failing CI, then what it is waiting on", () => {
    expect(status([pr({ mergeable: "CONFLICTING", conflictSince: ago(120), checks: { total: 1, pending: 0, failing: ["rspec"] } })])[0])
      .toMatchObject({ state: "conflict", reason: "conflicts with main", since: ago(120) });
    expect(status([pr({ mergeable: "UNKNOWN", conflictActive: true })])[0]!.state).toBe("conflict");
    expect(status([pr({ checks: { total: 6, pending: 0, failing: ["a", "b", "c", "d", "e"] } })])[0]!.reason).toBe("CI failing: a, b, c +2");
    expect(status([pr({ checks: { total: 4, pending: 3, failing: [] } })])[0]).toMatchObject({ state: "waiting", reason: "CI running (3 pending)" });
    expect(status([pr({ reviewDecision: "CHANGES_REQUESTED" })])[0]!.reason).toBe("changes requested in review");
    expect(status([pr({ mergeStateStatus: "BEHIND" })])[0]!.reason).toBe("behind main");
    expect(status([pr({ mergeable: "UNKNOWN" })])[0]!.reason).toBe("GitHub is still computing mergeability");
    expect(status([pr()], { subagents: [{ type: "reviewer", description: "Review PR 7", startedAt: ago(2) }] })[0]!.reason).toBe("review running");
    expect(status([pr()], { subagents: [shepherd({ endedAt: ago(200), message: "PR #7 is not merge-ready: blocked on a privacy decision." })] })[0])
      .toMatchObject({ state: "waiting", reason: "shepherd: PR #7 is not merge-ready: blocked on a privacy decision." });
  });

  test("an open PR whose agent is gone needs the operator", () => {
    expect(status([pr()], { alive: false })[0]).toMatchObject({ state: "waiting", needsMe: true, orphaned: true, reason: "CI green, no review verdict yet · agent not running" });
    expect(status([pr({ state: "MERGED", mergeCommit: "c".repeat(40), mergedAt: ago(30) })], { alive: false })[0])
      .toMatchObject({ state: "merged", reason: "merged at ccccccc", since: ago(30), needsMe: false });
  });

  test("finished PRs drop out after the recent window", () => {
    const old = new Date(NOW.getTime() - 4 * 86_400_000).toISOString();
    const prs = [
      pr({ number: 1, state: "MERGED", mergeCommit: "c".repeat(40), mergedAt: old }),
      pr({ number: 2, state: "CLOSED", closedAt: ago(60) }),
      pr({ number: 3, updatedAt: old }),
    ];
    expect(status(prs).map(item => [item.number, item.state])).toEqual([[2, "closed"], [3, "waiting"]]);
  });

  test("verdicts are read conservatively", () => {
    expect(shepherdVerdict("**Verdict: merge-ready.** PR #1 is still a draft")).toBe("ready");
    expect(shepherdVerdict("PR #2 is ready to merge")).toBe("ready");
    expect(shepherdVerdict("PR #3 is not yet merge-ready")).toBe("not-ready");
    expect(shepherdVerdict("No verdict yet: the coordinator asked me to hold")).toBe("not-ready");
    expect(shepherdVerdict("merge-ready except it is blocked on Alex")).toBe("not-ready");
    expect(shepherdVerdict("Waiting on the main reviewer and CI.")).toBeUndefined();
    expect(shepherdVerdict(undefined)).toBeUndefined();
  });
});
