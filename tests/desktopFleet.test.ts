import { describe, expect, test } from "bun:test";
import {
  agentId,
  agentKey,
  agentPath,
  ATTENTION_GROUP,
  buildTree,
  compareRows,
  conciergeId,
  conciergeTarget,
  countStatuses,
  fleetRows,
  isConciergeKey,
  isPinnedConcierge,
  matchesFilter,
  moveCursor,
  NO_REPO,
  parseAgentKey,
  repoLabel,
  type ConnectionFleet,
  type TreeItem,
} from "../desktop/src/fleet";
import { duration, relativeTime } from "../desktop/src/format";
import { parsePrefs } from "../desktop/src/store";
import type { AgentRow } from "../desktop/src/types";

const T0 = Date.parse("2026-01-01T12:00:00Z");
function row(name: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    name,
    status: "idle",
    statusChangedAt: new Date(T0).toISOString(),
    provider: "claude",
    dir: `/home/u/.agent-manager/worktrees/lighthouse/${name}`,
    repoRoot: "/home/u/code/lighthouse",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}
const fleet = (rows: AgentRow[], extra: Partial<ConnectionFleet> = {}): ConnectionFleet =>
  ({ id: "c1", name: "Home", local: "motel", rows, remoteHosts: [], unreachable: [], ...extra });
const opts = (extra: Partial<{ filter: string; showStopped: boolean; collapsed: Set<string> }> = {}) =>
  ({ filter: "", showStopped: false, collapsed: new Set<string>(), ...extra });
const labels = (items: TreeItem[]) => items.map((item) => (item.kind === "group" ? `[${item.label}]` : item.row.name));

describe("agent keys", () => {
  test("local agents use the name, remote ones host:name", () => {
    expect(agentId(row("a"))).toBe("a");
    expect(agentId(row("kelp", { host: "annex" }))).toBe("annex:kelp");
    expect(agentKey("conn-1", row("kelp", { host: "annex" }))).toBe("conn-1/annex:kelp");
  });
  test("parse splits at the first slash only", () => {
    expect(parseAgentKey("conn-1/annex:kelp")).toEqual({ connection: "conn-1", id: "annex:kelp" });
    expect(parseAgentKey("conn-1/a/b")).toEqual({ connection: "conn-1", id: "a/b" });
    expect(parseAgentKey("nope")).toBeNull();
    expect(parseAgentKey("/x")).toBeNull();
    expect(parseAgentKey("c/")).toBeNull();
  });
  test("the API path encodes the whole id as one segment", () => {
    expect(agentPath("annex:kelp")).toBe("/api/agents/annex%3Akelp");
    expect(agentPath("harbor-lights")).toBe("/api/agents/harbor-lights");
    expect(agentPath("a/b")).toBe("/api/agents/a%2Fb");
  });
});

describe("repository labels", () => {
  test("repoRoot basename, else dir basename, else No repository for home", () => {
    expect(repoLabel({ repoRoot: "/home/u/code/lighthouse/", dir: "/x" })).toBe("lighthouse");
    expect(repoLabel({ dir: "/srv/scratch/notes" })).toBe("notes");
    expect(repoLabel({ dir: "/home/u" })).toBe(NO_REPO);
    expect(repoLabel({ dir: "/Users/u/" })).toBe(NO_REPO);
    expect(repoLabel({ dir: "~" })).toBe(NO_REPO);
  });
});

describe("sorting", () => {
  test("status order then most recently updated", () => {
    const rows = [
      row("idle-old", { status: "idle", updatedAt: new Date(T0 - 5000).toISOString() }),
      row("stopped", { status: "exited" }),
      row("starting", { status: "starting" }),
      row("waiting", { status: "waiting" }),
      row("idle-new", { status: "idle", updatedAt: new Date(T0).toISOString() }),
      row("working", { status: "working" }),
      row("attention", { status: "needs-attention" }),
      row("dead", { status: "dead" }),
    ];
    expect(rows.sort(compareRows).map((r) => r.name)).toEqual(["attention", "working", "waiting", "starting", "idle-new", "idle-old", "dead", "stopped"]);
  });
});

describe("filter", () => {
  test("matches name, host, repo, branch and provider; all terms must match", () => {
    const r = row("harbor-lights", { worktreeBranch: "am/harbor-lights", provider: "codex", host: "annex" });
    expect(matchesFilter(r, "HARBOR")).toBe(true);
    expect(matchesFilter(r, "lighthouse codex")).toBe(true);
    expect(matchesFilter(r, "annex")).toBe(true);
    expect(matchesFilter(r, "lighthouse claude")).toBe(false);
    expect(matchesFilter(row("x", { repoRoot: undefined, dir: "/home/u" }), "motel", "motel")).toBe(true);
  });
});

describe("buildTree", () => {
  const rows = [
    row("harbor", { status: "working" }),
    row("fog", { status: "needs-attention" }),
    row("crane", { repoRoot: "/home/u/code/paper-crane" }),
    row("errand", { repoRoot: undefined, dir: "/home/u" }),
    row("old", { status: "exited" }),
    row("kelp", { host: "annex", repoRoot: "/home/u/code/tide-tables" }),
  ];

  test("attention pinned first, local host first, repos sorted with No repository last", () => {
    const tree = buildTree([fleet(rows, { remoteHosts: ["annex"] })], opts());
    expect(labels(tree.items)).toEqual([
      "[Needs attention]", "fog",
      "[motel]", "[lighthouse]", "fog", "harbor", "[paper-crane]", "crane", `[${NO_REPO}]`, "errand",
      "[annex]", "[tide-tables]", "kelp",
    ]);
    expect(tree.hiddenStopped).toBe(1);
    expect(tree.total).toBe(6);
    const pinned = tree.items[1]!;
    const grouped = tree.items.find((item) => item.kind === "agent" && item.parent !== ATTENTION_GROUP && item.row.name === "fog")!;
    // Same agent key in both places, distinct item ids.
    expect(pinned.kind === "agent" && grouped.kind === "agent" && pinned.key === grouped.key).toBe(true);
    expect(pinned.id).not.toBe(grouped.id);
  });

  test("show stopped reveals exited and dead agents", () => {
    const tree = buildTree([fleet(rows)], opts({ showStopped: true }));
    expect(labels(tree.items)).toContain("old");
    expect(tree.hiddenStopped).toBe(0);
  });

  test("collapsed groups hide their agents; a filter ignores collapse", () => {
    const collapsed = new Set(["r:c1::lighthouse", "h:c1:annex"]);
    const tree = buildTree([fleet(rows)], opts({ collapsed }));
    expect(labels(tree.items)).toEqual([
      "[Needs attention]", "fog", "[motel]", "[lighthouse]", "[paper-crane]", "crane", `[${NO_REPO}]`, "errand", "[annex]",
    ]);
    expect(tree.items.find((item) => item.id === "r:c1::lighthouse")).toMatchObject({ collapsed: true, count: 2 });
    const filtered = buildTree([fleet(rows)], opts({ collapsed, filter: "harbor" }));
    expect(labels(filtered.items)).toEqual(["[motel]", "[lighthouse]", "harbor"]);
  });

  test("unreachable remote hosts are marked, and shown even without agents", () => {
    const tree = buildTree([fleet([row("a")], { remoteHosts: ["lantern"], unreachable: ["lantern"] })], opts());
    expect(tree.items.at(-1)).toMatchObject({ kind: "group", label: "lantern", marker: "unreachable", count: 0 });
    const filtered = buildTree([fleet([row("a")], { remoteHosts: ["lantern"], unreachable: ["lantern"] })], opts({ filter: "a" }));
    expect(labels(filtered.items)).toEqual(["[motel]", "[lighthouse]", "a"]);
  });

  test("a connection level appears only with more than one connection", () => {
    const single = buildTree([fleet([row("a")])], opts());
    expect(single.items[0]).toMatchObject({ kind: "group", tone: "host", depth: 0 });
    const multi = buildTree([fleet([row("a")]), fleet([row("b")], { id: "c2", name: "Work", local: "desk" })], opts());
    expect(labels(multi.items)).toEqual(["[Home]", "[motel]", "[lighthouse]", "a", "[Work]", "[desk]", "[lighthouse]", "b"]);
    expect(multi.items[3]).toMatchObject({ key: "c1/a", depth: 3 });
  });

  test("keyboard cursor moves over visible items and clamps", () => {
    const tree = buildTree([fleet([row("a"), row("b")])], opts());
    const ids = tree.items.map((item) => item.id);
    expect(moveCursor(tree.items, null, 1)).toBe(ids[0]!);
    expect(moveCursor(tree.items, null, -1)).toBe(ids.at(-1)!);
    expect(moveCursor(tree.items, ids[0]!, 1)).toBe(ids[1]!);
    expect(moveCursor(tree.items, ids.at(-1)!, 1)).toBe(ids.at(-1)!);
    expect(moveCursor(tree.items, ids[0]!, -1)).toBe(ids[0]!);
    expect(moveCursor([], null, 1)).toBeNull();
  });
});

describe("concierge", () => {
  const keeper = (overrides: Partial<AgentRow> = {}) =>
    row("concierge", { role: "concierge", repoRoot: undefined, dir: "/home/u", ...overrides });
  const rows = [row("harbor", { status: "working" }), row("errand", { repoRoot: undefined, dir: "/home/u" }), keeper()];

  test("identified by the server's key, else by role, else not at all", () => {
    expect(conciergeId({ rows, conciergeKey: "concierge" })).toBe("concierge");
    // The request failed, or named a row that is not in the list: fall back to the role.
    expect(conciergeId({ rows, conciergeKey: null })).toBe("concierge");
    expect(conciergeId({ rows, conciergeKey: "annex:concierge" })).toBe("concierge");
    expect(conciergeId({ rows: [row("x", { role: { name: "concierge" } })] })).toBe("x");
    expect(conciergeId({ rows: [row("a"), row("concierge")] })).toBeNull();
    // The key wins over a role, and covers a concierge on a remote host.
    const remote = [row("helper", { role: "concierge" }), row("concierge", { host: "annex" })];
    expect(conciergeId({ rows: remote, conciergeKey: "annex:concierge" })).toBe("annex:concierge");
  });

  test("pinned first, outside every group and count, whatever the filter or stopped setting", () => {
    const tree = buildTree([fleet([...rows, row("fog", { status: "needs-attention" })], { conciergeKey: "concierge" })], opts());
    expect(labels(tree.items)).toEqual([
      "concierge", "[Needs attention]", "fog", "[motel]", "[lighthouse]", "fog", "harbor", `[${NO_REPO}]`, "errand",
    ]);
    expect(tree.items[0]).toMatchObject({ kind: "agent", concierge: true, key: "c1/concierge", depth: 0 });
    expect(tree.items.find((item) => item.kind === "group" && item.label === NO_REPO)).toMatchObject({ count: 1 });
    expect(tree.items.find((item) => item.kind === "group" && item.label === "motel")).toMatchObject({ count: 3 });
    expect(tree.total).toBe(3);
    expect(tree.shown).toBe(3);

    const filtered = buildTree([fleet(rows)], opts({ filter: "nothing-matches" }));
    expect(labels(filtered.items)).toEqual(["concierge"]);
    expect(filtered.shown).toBe(0);

    const stopped = buildTree([fleet([row("old", { status: "exited" }), keeper({ status: "dead" })])], opts());
    expect(labels(stopped.items)).toEqual(["concierge"]);
    expect(stopped.hiddenStopped).toBe(1);
    expect(stopped.total).toBe(1);

    const waiting = buildTree([fleet([keeper({ status: "needs-attention" })])], opts());
    expect(labels(waiting.items)).toEqual(["concierge"]);
  });

  test("no concierge row, nothing pinned", () => {
    expect(buildTree([fleet([row("a")])], opts()).items.some(isPinnedConcierge)).toBe(false);
  });

  test("counts exclude it", () => {
    expect(fleetRows(fleet(rows)).map((r) => r.name)).toEqual(["harbor", "errand"]);
    expect(countStatuses(fleetRows(fleet(rows)))).toMatchObject({ working: 1, idle: 1 });
  });

  test("a remote concierge does not conjure an empty host group", () => {
    const tree = buildTree([fleet([row("a"), row("concierge", { host: "annex" })], { conciergeKey: "annex:concierge" })], opts());
    expect(labels(tree.items)).toEqual(["concierge", "[motel]", "[lighthouse]", "a"]);
    expect(tree.items[0]).toMatchObject({ key: "c1/annex:concierge", hostLabel: "annex" });
    expect(isConciergeKey([fleet([row("concierge", { host: "annex" })], { conciergeKey: "annex:concierge" })], "c1/annex:concierge")).toBe(true);
    expect(isConciergeKey([fleet(rows)], "c1/harbor")).toBe(false);
    expect(isConciergeKey([fleet(rows)], "nope/concierge")).toBe(false);
  });

  test("one entry per connection, labelled with its name; c picks the open agent's connection", () => {
    const home = fleet(rows);
    const work = fleet([row("b"), keeper()], { id: "c2", name: "Work", local: "desk" });
    const tree = buildTree([home, work], opts());
    expect(labels(tree.items).slice(0, 3)).toEqual(["concierge", "concierge", "[Home]"]);
    expect(tree.items.slice(0, 2)).toMatchObject([{ key: "c1/concierge", connectionName: "Home" }, { key: "c2/concierge", connectionName: "Work" }]);
    expect(buildTree([home], opts()).items[0]).not.toHaveProperty("connectionName");
    expect(conciergeTarget([home, work], null)).toBe("c1/concierge");
    expect(conciergeTarget([home, work], "c2/b")).toBe("c2/concierge");
    expect(conciergeTarget([fleet([row("a")]), work], "c1/a")).toBe("c2/concierge");
    expect(conciergeTarget([fleet([row("a")])], null)).toBeNull();
  });

  test("the keyboard cursor starts on the pinned entry and walks into the list", () => {
    const tree = buildTree([fleet(rows)], opts());
    const ids = tree.items.map((item) => item.id);
    expect(moveCursor(tree.items, null, 1)).toBe("concierge>c1/concierge");
    expect(moveCursor(tree.items, ids[0]!, 1)).toBe(ids[1]!);
    expect(tree.items[1]).toMatchObject({ kind: "group", label: "motel" });
    expect(moveCursor(tree.items, ids[1]!, -1)).toBe(ids[0]!);
    expect(moveCursor(tree.items, ids[0]!, -1)).toBe(ids[0]!);
  });
});

describe("formatting and prefs", () => {
  test("relative time and durations", () => {
    expect(relativeTime(new Date(T0 - 30_000).toISOString(), T0)).toBe("now");
    expect(relativeTime(new Date(T0 - 3 * 60_000).toISOString(), T0)).toBe("3m");
    expect(relativeTime(new Date(T0 - 5 * 3600_000).toISOString(), T0)).toBe("5h");
    expect(relativeTime(new Date(T0 - 50 * 3600_000).toISOString(), T0)).toBe("2d");
    expect(relativeTime("garbage", T0)).toBe("");
    expect(duration(14_000)).toBe("14s");
    expect(duration(134_000)).toBe("2m 14s");
    expect(duration(3_900_000)).toBe("1h 5m");
  });
  test("prefs tolerate missing or corrupt storage", () => {
    expect(parsePrefs(null)).toEqual({ selected: null, sidebarWidth: 280, collapsed: [], showStopped: false });
    expect(parsePrefs("{not json")).toEqual({ selected: null, sidebarWidth: 280, collapsed: [], showStopped: false });
    expect(parsePrefs(JSON.stringify({ selected: "c/a", sidebarWidth: 320, collapsed: ["x", 3], showStopped: true })))
      .toEqual({ selected: "c/a", sidebarWidth: 320, collapsed: ["x"], showStopped: true });
  });
});
