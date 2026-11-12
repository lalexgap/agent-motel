import { describe, expect, test } from "bun:test";
import type { Fleet, FleetRow } from "../src/fleet";
import type { TrackedPullRequest } from "../src/prMonitor";
import { buildPrReport, formatPrReport } from "../src/prReport";
import type { PrStatus } from "../src/prStatus";
import { buildFleetSummary, formatFleetSummary } from "../src/summary";

const NOW = new Date("2026-07-22T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function row(name: string, status: FleetRow["status"], overrides: Partial<FleetRow> = {}): FleetRow {
  return { name, status, provider: "claude", queued: 0, updatedAt: ago(1), statusChangedAt: ago(1), dir: "/tmp", ...overrides };
}
function pr(number: number, overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, state: "waiting",
    reason: "CI green, no review verdict yet", needsMe: false, lastActivity: ago(number), ...overrides,
  };
}
function fleet(...rows: FleetRow[]): Fleet { return { rows, unreachable: [] }; }

describe("PR report", () => {
  test("sorts what needs the operator first, then merge-ready, then work in progress, then finished", () => {
    const report = buildPrReport(fleet(row("worker", "working", { host: "server", prStatus: [
      pr(1, { state: "merged", reason: "merged at abc1234", since: ago(5) }),
      pr(2, { state: "shepherding", reason: "shepherd running" }),
      pr(3, { state: "merge-ready", reason: "merge-ready: CI green, shepherd verdict" }),
      pr(4, { state: "conflict", reason: "conflicts with main" }),
      pr(5, { state: "needs-decision", reason: "needs decision: ship it?", needsMe: true }),
      pr(6, { state: "ci-failing", reason: "CI failing: rspec · agent not running", needsMe: true, orphaned: true }),
      pr(7),
    ] })), NOW);
    expect(report.prs.map(item => item.number)).toEqual([5, 6, 3, 4, 2, 7, 1]);
    expect(report.prs[0]).toMatchObject({ key: "owner/repo#5", agent: "server:worker", agentName: "worker", host: "server", agentStatus: "working" });
    expect(report.counts).toMatchObject({ open: 6, needsMe: 2, "merge-ready": 1, merged: 1, closed: 0 });
  });

  test("filters by state, repo and needs-me without changing the counts", () => {
    const rows = fleet(row("a", "idle", { prStatus: [pr(1, { needsMe: true, state: "needs-decision" }), pr(2, { repository: "other/thing", url: "https://github.com/other/thing/pull/2" })] }));
    expect(buildPrReport(rows, NOW, { needsMe: true }).prs.map(item => item.number)).toEqual([1]);
    expect(buildPrReport(rows, NOW, { repo: "thing" }).prs.map(item => item.key)).toEqual(["other/thing#2"]);
    expect(buildPrReport(rows, NOW, { repo: "OWNER/REPO" }).prs.map(item => item.number)).toEqual([1]);
    const waiting = buildPrReport(rows, NOW, { state: "waiting" });
    expect(waiting.prs.map(item => item.number)).toEqual([2]);
    expect(waiting.counts).toMatchObject({ open: 2, needsMe: 1 });
  });

  test("a PR tracked by two agents is one row, owned by the agent that can still act", () => {
    const report = buildPrReport(fleet(
      row("gone", "exited", { prStatus: [pr(1, { needsMe: true, orphaned: true, lastActivity: ago(0) })] }),
      row("taker", "working", { prStatus: [pr(1, { state: "shepherding", reason: "shepherd running" })] }),
    ), NOW);
    expect(report.prs).toHaveLength(1);
    expect(report.prs[0]).toMatchObject({ agent: "taker", state: "shepherding", alsoTrackedBy: ["gone"] });
    expect(report.counts.needsMe).toBe(0);
  });

  test("links dependent PRs into a stack by branch", () => {
    const report = buildPrReport(fleet(row("stacker", "working", { prStatus: [
      pr(1, { baseRefName: "main", headRefName: "layer-1" }),
      pr(2, { baseRefName: "layer-1", headRefName: "layer-2" }),
      pr(3, { baseRefName: "layer-2", headRefName: "layer-3" }),
      pr(4, { baseRefName: "main", headRefName: "solo" }),
      pr(5, { baseRefName: "layer-1", headRefName: "elsewhere", repository: "other/repo", url: "https://github.com/other/repo/pull/5" }),
    ] })), NOW);
    const stack = Object.fromEntries(report.prs.map(item => [item.number, item.stack]));
    expect(stack[1]).toEqual({ position: 1, size: 3, children: [2] });
    expect(stack[2]).toEqual({ position: 2, size: 3, parent: 1, children: [3] });
    expect(stack[3]).toEqual({ position: 3, size: 3, parent: 2, children: [] });
    expect(stack[4]).toBeUndefined();
    expect(stack[5]).toBeUndefined();
  });

  test("derives what it can for a host that sends no prStatus, and keeps old PRs only with all", () => {
    const tracked = (number: number, extra: Partial<TrackedPullRequest> = {}): TrackedPullRequest => ({
      repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, state: "OPEN", updatedAt: ago(3), mergeable: "MERGEABLE", ...extra,
    });
    const old = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const rows = fleet(row("legacy", "working", {
      host: "old", prMonitor: { error: "PR lookup or delivery unavailable; retrying next sweep.", pullRequests: [
        tracked(1), tracked(2, { state: "MERGED", mergeCommit: "d".repeat(40), mergedAt: old, updatedAt: old }),
      ] },
      subagents: { active: 1, types: "shepherd", detail: "1 subagent", running: [{ id: "x", type: "shepherd", description: "Shepherd PR 1", startedAt: ago(9) }] },
    }));
    const report = buildPrReport(rows, NOW);
    expect(report.prs.map(item => [item.number, item.state])).toEqual([[1, "shepherding"]]);
    expect(report.stale).toEqual(["old:legacy"]);
    expect(buildPrReport(rows, NOW, { all: true }).prs.map(item => [item.number, item.state])).toEqual([[1, "shepherding"], [2, "merged"]]);
  });

  test("the text view marks who acts, appends how long, and trims finished PRs", () => {
    const merged = Array.from({ length: 10 }, (_item, index) => pr(20 + index, { state: "merged", reason: "merged at abc1234", since: ago(60) }));
    const text = formatPrReport(buildPrReport(fleet(row("worker", "working", { prStatus: [
      pr(1, { state: "needs-decision", reason: "needs decision: ship it?", needsMe: true, since: ago(125), title: "Ship the importer" }),
      pr(2, { state: "merge-ready", reason: "merge-ready: CI green, shepherd verdict", readyMark: { current: false, note: "not marked with am pr --ready" },
        baseRefName: "main", headRefName: "a" }),
      pr(3, { baseRefName: "a", headRefName: "b" }),
      ...merged,
    ] })), NOW), NOW).join("\n");
    expect(text).toContain("PRs: 3 open · 1 need you · 1 merge-ready");
    expect(text).toMatch(/! needs-decision\s+owner\/repo#1\s+worker\s+needs decision: ship it\? · 2h\s+1m ago\s+Ship the importer/);
    expect(text).toMatch(/✔ merge-ready\s+owner\/repo#2 \[1\/2\].*\(not marked with am pr --ready\)/);
    expect(text).toContain("… 2 more merged or closed");
    expect(formatPrReport(buildPrReport(fleet(), NOW))[0]).toContain("No tracked PRs");
  });

  test("the fleet summary names the PRs needing the operator and the merge-ready ones", () => {
    const summary = buildFleetSummary(fleet(
      row("blocked", "needs-attention", { statusReason: "approval requested" }),
      row("worker", "working", { prStatus: [
        pr(1, { state: "needs-decision", reason: "needs decision: ship it?", needsMe: true, since: ago(125) }),
        pr(2, { state: "merge-ready", reason: "merge-ready: CI green, shepherd verdict" }),
        pr(3),
      ] }),
    ), NOW);
    expect(summary.prs).toEqual({
      needsMe: [{ key: "owner/repo#1", url: "https://github.com/owner/repo/pull/1", agent: "worker", state: "needs-decision", reason: "needs decision: ship it? · 2h" }],
      mergeReady: [{ key: "owner/repo#2", url: "https://github.com/owner/repo/pull/2", agent: "worker", state: "merge-ready", reason: "merge-ready: CI green, shepherd verdict" }],
    });
    const lines = formatFleetSummary(summary);
    const at = (text: string) => lines.findIndex(line => line.startsWith(text));
    expect(at("PRs needing you (1)")).toBeGreaterThan(at("Needs attention (1)"));
    expect(at("PRs merge-ready (1)")).toBeGreaterThan(at("PRs needing you (1)"));
    expect(at("Active (1)")).toBeGreaterThan(at("PRs merge-ready (1)"));
    expect(lines).toContain("  owner/repo#1 — needs decision: ship it? · 2h (worker)");
    expect(buildFleetSummary(fleet(row("quiet", "idle", { prStatus: [pr(3)] })), NOW)).not.toHaveProperty("prs");
  });
});
