import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { buildTree, busySubagents, LIST_GROUP, rowReasonBeside, rowStatusLabel, workingLabel, type ConnectionFleet, type TreeItem } from "../desktop/src/fleet";
import {
  compareOverview,
  compareSidebar,
  elapsed,
  matchesOverviewFilter,
  matchesOverviewQuery,
  overviewCounts,
  parentId,
  repoName,
  runtimeMs,
  sidebarMeta,
  sidebarRank,
  statusGroup,
  type OverviewSort,
  type SidebarGroup,
  type SidebarSort,
} from "../desktop/src/ordering";
import type { AgentRow, AgentStatus } from "../desktop/src/types";
import { Unread } from "../desktop/src/unread";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
function row(name: string, status: AgentStatus, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    name, status, provider: "claude", statusChangedAt: ago(10), updatedAt: ago(10), createdAt: ago(100),
    dir: `/home/u/.agent-manager/worktrees/lighthouse/${name}`, repoRoot: "/home/u/code/lighthouse", ...overrides,
  };
}

// A fleet that exercises every rank, ties on each key, missing fields and odd statuses.
const ROWS: AgentRow[] = [
  row("harbor", "working", { statusChangedAt: ago(30), updatedAt: ago(1) }),
  row("fog", "needs-attention", { updatedAt: ago(4) }),
  row("drift", "waiting", { statusChangedAt: ago(90), updatedAt: ago(2) }),
  row("keeper", "idle", { updatedAt: ago(12) }),
  row("old-lens", "exited", { updatedAt: ago(300) }),
  row("paper", "dead", { updatedAt: ago(1500), repoRoot: "/home/u/code/paper-crane" }),
  row("origami", "starting", { updatedAt: ago(0.2), repoRoot: "/home/u/code/paper-crane", spawnedBy: "crease" }),
  row("crease", "idle", { updatedAt: ago(26), repoRoot: "/home/u/code/paper-crane" }),
  row("alpha", "idle", { updatedAt: ago(26), repoRoot: undefined, dir: "/home/u" }),
  row("kelp", "working", { host: "annex", statusChangedAt: ago(30), updatedAt: ago(0.3), repoRoot: "/srv/tide-tables/" }),
  row("sandbar", "needs-attention", { host: "annex", updatedAt: "not a date" }),
  row("zeta", "working", { statusChangedAt: "", updatedAt: ago(5) }),
  row("odd", "mystery" as AgentStatus, { updatedAt: ago(7) }),
  row("Beacon", "idle", { updatedAt: ago(12), repoRoot: "/home/u/code/lighthouse-2" }),
];

// The browser UI's own functions, evaluated from web/app.js so the two cannot drift silently.
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};
class FixedDate extends Date {
  static now() {
    return NOW;
  }
}
function browser() {
  const state = { sort: "status", reverse: false };
  const helpers = slice("const attention = (row) =>", "const dot = (status) =>") + slice("const statusName = (status) =>", "|| status;") + "|| status;";
  const context: Record<string, unknown> = { state, Date: FixedDate };
  runInNewContext(helpers + slice("function repoPath(row)", "function renderFleet()") + slice("function statusGroup(status)", "function saveDraft()") +
    slice("function parentKey(row)", "$(\"show-finished-subagents\")") +
    "this.api = { repoName, runtime, elapsed, compareRows, statusGroup, parentKey };", context);
  // The sidebar's ordering lives inline in renderFleet: run exactly those lines.
  const sidebarSource = slice("const sidebarRank =", "for (const row of sidebarRows)");
  const sidebar = (rows: AgentRow[], grouping: string): AgentRow[] =>
    runInNewContext(`(() => { ${sidebarSource}; return sidebarRows; })()`, {
      rows, repoName: (context.api as any).repoName, $: () => ({ value: grouping }),
    });
  return { state, api: context.api as any, sidebar };
}

describe("parity with the browser UI (web/app.js)", () => {
  const web = browser();

  test.each(["status", "repo", "runtime", "recent", "name"] as OverviewSort[])("overview sort %s, both directions", (sort) => {
    for (const reverse of [false, true]) {
      web.state.sort = sort;
      web.state.reverse = reverse;
      const theirs = [...ROWS].sort(web.api.compareRows).map((r) => r.name);
      const ours = [...ROWS].sort((a, b) => compareOverview(a, b, { sort, reverse, now: NOW })).map((r) => r.name);
      expect(ours).toEqual(theirs);
    }
  });

  test("status groups, runtimes, elapsed and repo names", () => {
    for (const status of ["needs-attention", "working", "waiting", "idle", "starting", "exited", "dead", "mystery"])
      expect(statusGroup(status)).toBe(web.api.statusGroup(status));
    for (const r of ROWS) {
      expect(runtimeMs(r, NOW)).toBe(web.api.runtime(r));
      expect(repoName(r)).toBe(web.api.repoName(r));
      expect(parentId(r)).toBe(web.api.parentKey(r));
    }
    for (const ms of [-1, 0, 59_999, 60_000, 59 * 60_000, 3_600_000, 3_660_000, 23 * 3_600_000 + 59 * 60_000, 86_400_000, 90_000_000, 400 * 86_400_000])
      expect(elapsed(ms)).toBe(web.api.elapsed(ms));
  });

  test.each(["status", "repo", "host"] as SidebarGroup[])("sidebar order grouped by %s", (group) => {
    const theirs = web.sidebar([...ROWS], group === "status" ? "" : group).map((r) => r.name);
    const tree = buildTree([fleetOf(ROWS, "")], { filter: "", showStopped: true, collapsed: new Set(), group, now: NOW });
    expect(agents(tree.items, group)).toEqual(theirs);
  });
});

const fleetOf = (rows: AgentRow[], local = "motel", extra: Partial<ConnectionFleet> = {}): ConnectionFleet =>
  ({ id: "c1", name: "Home", local, rows, remoteHosts: [], unreachable: [], ...extra });
// Agent names in render order, without the pinned "Needs attention" copies.
const agents = (items: TreeItem[], group: SidebarGroup | "tree" = "tree") =>
  items.filter((item) => item.kind === "agent" && !item.concierge && (group === "status" || item.parent !== "attention"))
    .map((item) => (item.kind === "agent" ? item.row.name : ""));
const labels = (items: TreeItem[]) => items.map((item) => (item.kind === "group" ? `[${item.label}]` : item.row.name));

describe("overview filters and counts", () => {
  test("live, needs attention, stopped and all", () => {
    expect(overviewCounts(ROWS)).toEqual({ live: 12, attention: 2, exited: 2, all: 14 });
    expect(ROWS.filter((r) => matchesOverviewFilter(r, "exited")).map((r) => r.name)).toEqual(["old-lens", "paper"]);
    // Waiting is busy on its own, not waiting on you.
    expect(matchesOverviewFilter(row("w", "waiting"), "attention")).toBe(false);
  });
  test("text filter over name, task, host and dir, plus what the card shows", () => {
    const r = row("harbor", "idle", { task: "Add a Retry budget", host: "annex" });
    expect(matchesOverviewQuery(r, "retry")).toBe(true);
    expect(matchesOverviewQuery(r, "ANNEX")).toBe(true);
    expect(matchesOverviewQuery(r, "worktrees/lighthouse")).toBe(true);
    expect(matchesOverviewQuery(r, "claude")).toBe(false);
    expect(matchesOverviewQuery(row("x", "idle"), "motel", ["motel"])).toBe(true);
  });
});

describe("sidebar sorting and grouping", () => {
  const names = (sort: SidebarSort, reverse = false) => [...ROWS].sort((a, b) => compareSidebar(a, b, { sort, reverse, now: NOW })).map((r) => r.name);
  test("status rank: attention, busy, starting, idle, everything else; then name", () => {
    expect(sidebarRank("needs-attention")).toBe(0);
    expect(sidebarRank("waiting")).toBe(sidebarRank("working"));
    expect(sidebarRank("exited")).toBe(4);
    expect(names("status")).toEqual(["fog", "sandbar", "drift", "harbor", "kelp", "zeta", "origami", "alpha", "Beacon", "crease", "keeper", "odd", "old-lens", "paper"]);
    expect(names("status", true)).toEqual([...names("status")].reverse());
  });
  test("recent, runtime and name", () => {
    expect(names("recent").slice(0, 4)).toEqual(["origami", "kelp", "harbor", "drift"]);
    expect(names("recent").at(-1)).toBe("sandbar");
    expect(names("runtime").slice(0, 3)).toEqual(["drift", "harbor", "kelp"]);
    expect(names("name").slice(0, 3)).toEqual(["alpha", "Beacon", "crease"]);
  });
  test("flat Status list: no headers and no separate Needs attention section", () => {
    const tree = buildTree([fleetOf(ROWS)], { filter: "", showStopped: false, collapsed: new Set(), group: "status", now: NOW });
    expect(tree.items.every((item) => item.kind === "agent" && item.parent === LIST_GROUP && item.depth === 0)).toBe(true);
    expect(labels(tree.items)[0]).toBe("fog");
  });
  test("repository groups by name, attention section kept, collapsible", () => {
    const tree = buildTree([fleetOf(ROWS)], { filter: "", showStopped: false, collapsed: new Set(["g:repo:paper-crane"]), group: "repo", now: NOW });
    expect(labels(tree.items)).toEqual([
      "[Needs attention]", "fog", "sandbar",
      "[lighthouse]", "fog", "sandbar", "drift", "harbor", "zeta", "keeper", "odd",
      "[lighthouse-2]", "Beacon", "[paper-crane]", "[tide-tables]", "kelp", "[u]", "alpha",
    ]);
    expect(tree.items.find((item) => item.id === "g:repo:paper-crane")).toMatchObject({ collapsed: true, count: 2 });
  });
  test("host groups use the server's own name for local agents, This server when unknown, and mark unreachable hosts", () => {
    const rows = [row("a", "idle"), row("b", "working", { host: "annex" }), row("c", "idle", { host: "zulu" })];
    const tree = buildTree([fleetOf(rows, "motel", { unreachable: ["lantern"] })], { filter: "", showStopped: false, collapsed: new Set(), group: "host", now: NOW });
    expect(labels(tree.items)).toEqual(["[annex]", "b", "[lantern]", "[motel]", "a", "[zulu]", "c"]);
    expect(tree.items[2]).toMatchObject({ marker: "unreachable", count: 0 });
    const unknown = buildTree([fleetOf(rows, "")], { filter: "", showStopped: false, collapsed: new Set(), group: "host", now: NOW });
    expect(labels(unknown.items)).toContain("[This server]");
    const two = buildTree([fleetOf(rows), { ...fleetOf([row("d", "idle")], "desk"), id: "c2", name: "Work" }],
      { filter: "", showStopped: false, collapsed: new Set(), group: "host", now: NOW });
    expect(labels(two.items)).toContain("[desk · Work]");
  });
});

describe("sidebar row meta", () => {
  test("status · detail · queued · age · pull requests", () => {
    const meta = sidebarMeta(row("a", "needs-attention", {
      statusReason: "reason", statusDetail: "detail", queued: 2, updatedAt: ago(75),
      prMonitor: { pullRequests: [{ number: 12, state: "OPEN" }, { number: 13, state: "MERGED" }] },
    }), NOW);
    expect(meta).toEqual({ status: "Needs attention", reason: "detail", queued: "2 queued", age: "1h 15m ago", prs: "PR #12 · open, PR #13 · merged" });
    expect(sidebarMeta(row("b", "idle", { updatedAt: "" }), NOW)).toEqual({ status: "Idle", reason: "", queued: "", age: "", prs: "" });
  });
});

describe("an agent waiting on its subagents", () => {
  const reason = "waiting on 2 subagents (Shepherd PR 12, reviewer)";
  const waiting = row("bosun", "working", { rawStatus: "idle", busyWith: { subagents: 2, background: 0 }, statusReason: reason, statusDetail: reason, updatedAt: ago(2) });

  test("workingLabel matches the browser UI's for every status and count", () => {
    const context: Record<string, unknown> = {};
    runInNewContext(slice("function workingLabel(", "function tickWorking(") + "this.workingLabel = workingLabel;", context);
    const web = context.workingLabel as (status: string, subagents?: number) => string;
    for (const status of ["working", "starting", "waiting", "idle", "needs-attention", "mystery", ""])
      for (const count of [undefined, 0, 1, 2, 5]) expect(workingLabel(status, count)).toBe(web(status, count));
    expect(workingLabel("working", 2)).toBe("Waiting on 2 subagents");
    expect(workingLabel("working", 1)).toBe("Waiting on 1 subagent");
    expect(workingLabel("working", 0)).toBe("Working");
    expect(workingLabel("waiting", 3)).toBe("Waiting on background tasks");
  });

  test("the row's label says what it waits on; only a working agent with live subagents changes", () => {
    expect(rowStatusLabel(waiting)).toBe("Waiting on 2 subagents");
    expect(rowStatusLabel(row("a", "working"))).toBe("Working");
    expect(rowStatusLabel(row("a", "working", { busyWith: null }))).toBe("Working");
    expect(rowStatusLabel(row("a", "working", { busyWith: { subagents: 0, background: 2 } }))).toBe("Working");
    expect(rowStatusLabel(row("a", "waiting", { busyWith: { subagents: 2, background: 1 } }))).toBe("Waiting on background tasks");
    expect(rowStatusLabel(row("a", "needs-attention", { rawStatus: "idle" }))).toBe("Needs attention");
    expect(busySubagents({ busyWith: { subagents: -1, background: 0 } })).toBe(0);
  });

  test("the reason beside the label drops what the label already says", () => {
    expect(rowReasonBeside(waiting, reason)).toBe("Shepherd PR 12, reviewer");
    expect(rowReasonBeside(waiting, "waiting on 2 subagents (Shepherd PR 12, reviewer) and 1 shell")).toBe("Shepherd PR 12, reviewer and 1 shell");
    // am clips the detail; a lost closing parenthesis still reads cleanly.
    expect(rowReasonBeside(waiting, "waiting on 2 subagents (Shepherd PR 12, revi…")).toBe("Shepherd PR 12, revi…");
    expect(rowReasonBeside(waiting, "something else")).toBe("something else");
    expect(rowReasonBeside(row("a", "working"), "waiting on 2 subagents (x)")).toBe("waiting on 2 subagents (x)");
    expect(sidebarMeta(waiting, NOW)).toEqual({ status: "Waiting on 2 subagents", reason: "Shepherd PR 12, reviewer", queued: "", age: "2m ago", prs: "" });
  });
});

describe("unread", () => {
  test("never-opened agents are not new; seen moves forward only; the open agent is never new", () => {
    const unread = new Unread();
    expect(unread.isNew("c/a", ago(1), null)).toBe(false);
    expect(unread.markSeen("c/a", ago(5))).toBe(true);
    expect(unread.isNew("c/a", ago(5), null)).toBe(false);
    expect(unread.isNew("c/a", ago(1), null)).toBe(true);
    expect(unread.isNew("c/a", ago(1), "c/a")).toBe(false);
    expect(unread.markSeen("c/a", ago(9))).toBe(false);
    expect(unread.markSeen("c/a", ago(5))).toBe(false);
    expect(unread.markSeen("c/a", undefined)).toBe(false);
    expect(unread.markSeen("c/a", ago(1))).toBe(true);
    expect(unread.isNew("c/a", ago(1), null)).toBe(false);
  });
  test("the read boundary is the last entry index read", () => {
    const unread = new Unread();
    expect(unread.boundary("c/a")).toBeNull();
    unread.markRead("c/a", 7);
    expect(unread.boundary("c/a")).toBe(7);
    unread.markRead("c/a", Number.NaN);
    expect(unread.boundary("c/a")).toBe(7);
  });
});
