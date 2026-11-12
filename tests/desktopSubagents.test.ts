import { describe, expect, test } from "bun:test";
import { buildTree, type AgentItem, type ConnectionFleet, type SubagentItem, type TreeItem } from "../desktop/src/fleet";
import {
  clampInspectorWidth,
  DEFAULT_INSPECTOR_PREFS,
  INSPECTOR_MIN,
  inspectorDocks,
  inspectorMax,
  parseInspectorPrefs,
  serializeInspectorPrefs,
} from "../desktop/src/inspectorModel";
import { validateApiPath } from "../desktop/src/policy";
import {
  activeTokens,
  childRows,
  compactTokens,
  itemKey,
  nestSubagents,
  NOT_AVAILABLE,
  parentId,
  parentKeyOf,
  parseRecords,
  parseSubagentKey,
  resolveState,
  runningOf,
  shouldPoll,
  sortSubagents,
  stateFromLabel,
  subagentKey,
  subagentLabel,
  subagentsAvailable,
  subagentState,
  subagentTranscriptPath,
  tokenText,
  visibleSubagents,
} from "../desktop/src/subagents";
import type { AgentRow, SubagentRecord } from "../desktop/src/types";

function row(name: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    name, status: "idle", statusChangedAt: "2026-01-01T00:00:00Z", provider: "claude", dir: "/home/keeper/code/lighthouse",
    repoRoot: "/home/keeper/code/lighthouse", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}
const record = (id: string, startedAt: string, overrides: Partial<SubagentRecord> = {}): SubagentRecord => ({ id, type: "general-purpose", startedAt, ...overrides });
const running = (...items: { id: string; type?: string; description?: string }[]) => ({
  active: items.length, types: "", detail: "", running: items.map((item) => ({ type: "Explore", startedAt: "2026-01-01T00:05:00Z", ...item })),
});

describe("subagent keys", () => {
  test("round-trip agent key and id, remote agents included", () => {
    expect(subagentKey("c1/harbor-lights", "a3f1")).toBe("c1/harbor-lights#a3f1");
    expect(parseSubagentKey("c1/harbor-lights#a3f1")).toEqual({ agentKey: "c1/harbor-lights", id: "a3f1" });
    expect(parseSubagentKey(subagentKey("c1/annex:kelp-forest", "b8_4-d"))).toEqual({ agentKey: "c1/annex:kelp-forest", id: "b8_4-d" });
  });
  test("rejects keys am would not accept", () => {
    for (const key of ["c1/harbor-lights", "#a3f1", "c1/harbor-lights#", "c1/x#bad id", "c1/x#a/b", `c1/x#${"a".repeat(129)}`]) expect(parseSubagentKey(key)).toBeNull();
  });
  test("transcript path is a valid bridge path with the id encoded", () => {
    const path = subagentTranscriptPath("/api/agents/annex%3Akelp-forest", "b84d02e6c1a9f357");
    expect(path).toBe("/api/agents/annex%3Akelp-forest/transcript?subagent=b84d02e6c1a9f357");
    expect(validateApiPath(path)).toBeNull();
    expect(validateApiPath("/api/agents/harbor-lights/subagents")).toBeNull();
  });
});

describe("records", () => {
  test("label: description, else type, else id", () => {
    expect(subagentLabel({ description: "Map the /status handlers", type: "Explore" })).toBe("Map the /status handlers");
    expect(subagentLabel({ description: "  ", type: "Explore" })).toBe("Explore");
    expect(subagentLabel({ id: "a3f1" })).toBe("a3f1");
  });
  test("state: finished wins, stale when the server or a stopped agent says so", () => {
    expect(subagentState({ endedAt: "2026-01-01T00:01:00Z" })).toBe("finished");
    expect(subagentState({ endedAt: "2026-01-01T00:01:00Z", stale: true })).toBe("finished");
    expect(subagentState({ stale: true })).toBe("stale");
    expect(subagentState({})).toBe("running");
    expect(subagentState({}, "exited")).toBe("stale");
    expect(subagentState({}, "dead")).toBe("stale");
    expect(subagentState({}, "working")).toBe("running");
  });
  test("the usage page's status words map back to states", () => {
    expect(stateFromLabel("Running")).toBe("running");
    expect(stateFromLabel("Finished")).toBe("finished");
    expect(stateFromLabel("Session ended")).toBe("stale");
    expect(stateFromLabel(undefined)).toBeNull();
    expect(stateFromLabel("Paused")).toBeNull();
  });
  test("sort: running first, then newest; Show finished filters", () => {
    const old = record("old", "2026-01-01T00:00:00Z", { endedAt: "2026-01-01T00:01:00Z" });
    const stale = record("stale", "2026-01-01T00:09:00Z", { stale: true });
    const a = record("a", "2026-01-01T00:02:00Z");
    const b = record("b", "2026-01-01T00:04:00Z");
    const done = record("done", "2026-01-01T00:08:00Z", { endedAt: "2026-01-01T00:08:30Z" });
    expect(sortSubagents([old, a, stale, b, done]).map((item) => item.id)).toEqual(["b", "a", "stale", "done", "old"]);
    expect(visibleSubagents([old, a, stale, b, done], false).map((item) => item.id)).toEqual(["b", "a"]);
    expect(visibleSubagents([old, a, stale, b, done], true)).toHaveLength(5);
  });
  test("tokens count new input, cache writes and output, compacted like the usage page", () => {
    expect(activeTokens({ inputTokens: 2140, cacheCreationTokens: 9870, cacheReadTokens: 61200, outputTokens: 6412 })).toBe(18422);
    expect(activeTokens(undefined)).toBe(0);
    expect(compactTokens(18422)).toBe("18k");
    expect(compactTokens(1234)).toBe("1.2k");
    expect(compactTokens(12_345_678)).toBe("12M");
    expect(compactTokens(950)).toBe("950");
    expect(tokenText({ inputTokens: 2140, cacheCreationTokens: 9870, outputTokens: 6412 })).toBe("18k tok");
    expect(tokenText({ cacheReadTokens: 500 })).toBeNull();
  });
  test("parseRecords keeps well-formed records only", () => {
    const good = record("a3f1c9e27b5d4e80", "2026-01-01T00:00:00Z");
    expect(parseRecords({ records: [good, null, { id: "bad id", type: "x", startedAt: "" }, { id: "x" }, "nope"] })).toEqual([good]);
    expect(parseRecords(null)).toEqual([]);
    expect(parseRecords({ records: "x" })).toEqual([]);
  });
  test("availability follows the browser UI's capabilityAvailable", () => {
    expect(subagentsAvailable({ provider: "claude", capabilities: { subagents: true } })).toBe(true);
    expect(subagentsAvailable({ provider: "codex", capabilities: {} })).toBe(true);
    expect(subagentsAvailable({ provider: "claude", capabilities: { subagents: false } })).toBe(false);
    expect(subagentsAvailable({ provider: "antigravity", capabilities: {} })).toBe(false);
    expect(subagentsAvailable(null)).toBe(false);
  });
});

describe("status resolution and polling", () => {
  const parent = row("harbor-lights", { status: "working", subagents: running({ id: "b8" }) });
  test("the record wins; a stopped parent makes an open record stale", () => {
    expect(resolveState({ record: record("b8", "2026-01-01T00:00:00Z", { endedAt: "2026-01-01T00:02:00Z" }), row: parent, id: "b8" })).toBe("finished");
    expect(resolveState({ record: record("b8", "2026-01-01T00:00:00Z"), row: { ...parent, status: "exited" }, id: "b8" })).toBe("stale");
  });
  test("without a record: listed in the fleet row means running, then the transcript, then the opener's hint", () => {
    expect(resolveState({ row: parent, id: "b8", hint: "finished" })).toBe("running");
    expect(resolveState({ row: parent, id: "zz", transcriptStatus: "exited" })).toBe("finished");
    expect(resolveState({ row: parent, id: "zz", hint: "finished" })).toBe("finished");
    expect(resolveState({ id: "zz" })).toBeNull();
  });
  test("polls while running or unknown", () => {
    expect(shouldPoll("running")).toBe(true);
    expect(shouldPoll(null)).toBe(true);
    expect(shouldPoll("finished")).toBe(false);
    expect(shouldPoll("stale")).toBe(false);
  });
  test("the not-available wording is the browser UI's", () => {
    expect(NOT_AVAILABLE).toBe("Output is not available yet. Running Codex subagents may publish their transcript only when they finish.");
  });
});

describe("AM parent and child agents", () => {
  test("parentId qualifies a remote child's bare spawnedBy with its host", () => {
    expect(parentId({ spawnedBy: "crease-check" })).toBe("crease-check");
    expect(parentId({ spawnedBy: "sandbar", host: "annex" })).toBe("annex:sandbar");
    expect(parentId({ spawnedBy: "annex:sandbar" })).toBe("annex:sandbar");
    expect(parentId({})).toBeNull();
    expect(parentKeyOf("c1", { spawnedBy: "crease-check" })).toBe("c1/crease-check");
  });
  test("childRows lists the agents it spawned; stopped ones only with Show finished", () => {
    const rows = [
      row("crease-check"),
      row("origami-docs", { spawnedBy: "crease-check", status: "starting" }),
      row("old-fold", { spawnedBy: "crease-check", status: "exited" }),
      row("other", { spawnedBy: "keeper-log" }),
      row("remote", { host: "annex", spawnedBy: "crease-check" }),
    ];
    expect(childRows("c1", rows, "c1/crease-check", false).map((item) => item.name)).toEqual(["origami-docs"]);
    expect(childRows("c1", rows, "c1/crease-check", true).map((item) => item.name)).toEqual(["origami-docs", "old-fold"]);
    expect(childRows("c1", rows, "c1/annex:crease-check", false).map((item) => item.name)).toEqual(["remote"]);
  });
});

describe("nested sidebar rows", () => {
  const fleet = (rows: AgentRow[]): ConnectionFleet => ({ id: "c1", name: "Motel", local: "motel", rows, remoteHosts: [], unreachable: [], conciergeKey: "concierge" });
  const tree = (rows: AgentRow[], collapsed: string[] = []): TreeItem[] =>
    nestSubagents(buildTree([fleet(rows)], { filter: "", showStopped: false, collapsed: new Set(collapsed) }).items);
  const subs = (items: TreeItem[]) => items.filter((item): item is SubagentItem => item.kind === "subagent");

  test("running subagents follow their parent's row, one level deeper, with subagent keys", () => {
    const items = tree([row("harbor-lights", { status: "working", subagents: running({ id: "b8", description: "Map the /status handlers" }, { id: "c6", type: "general-purpose" }) }), row("keeper-log")]);
    const parentIndex = items.findIndex((item) => item.kind === "agent" && item.key === "c1/harbor-lights");
    const parent = items[parentIndex] as AgentItem;
    expect(items.slice(parentIndex + 1, parentIndex + 3)).toEqual([
      { kind: "subagent", id: `${parent.id}#b8`, key: "c1/harbor-lights#b8", agentKey: "c1/harbor-lights", subagentId: "b8", label: "Map the /status handlers", startedAt: "2026-01-01T00:05:00Z", depth: parent.depth + 1, parent: parent.id },
      expect.objectContaining({ key: "c1/harbor-lights#c6", label: "general-purpose" }),
    ]);
    expect(subs(items)).toHaveLength(2);
  });
  test("newest first, as the inspector lists them", () => {
    const summary = { active: 2, types: "", detail: "", running: [
      { id: "old", type: "Explore", startedAt: "2026-01-01T00:01:00Z" },
      { id: "new", type: "Explore", startedAt: "2026-01-01T00:09:00Z" },
    ] };
    expect(subs(tree([row("harbor-lights", { subagents: summary })])).map((item) => item.subagentId)).toEqual(["new", "old"]);
  });
  test("not under the pinned Needs attention duplicate, but under its repository row", () => {
    const items = tree([row("fog-signal", { status: "needs-attention", subagents: running({ id: "b8" }) })]);
    const nested = subs(items);
    expect(nested).toHaveLength(1);
    expect(nested[0]!.parent.startsWith("attention>")).toBe(false);
    expect(nested[0]!.parent.startsWith("r:c1:")).toBe(true);
  });
  test("under the pinned concierge, which appears nowhere else", () => {
    const items = tree([row("concierge", { role: "concierge", dir: "/home/keeper", repoRoot: undefined, subagents: running({ id: "b8" }) })]);
    expect(subs(items).map((item) => item.parent)).toEqual(["concierge>c1/concierge"]);
  });
  test("collapsed with their parent's group", () => {
    const rows = [row("harbor-lights", { subagents: running({ id: "b8" }) })];
    expect(subs(tree(rows, ["r:c1::lighthouse"]))).toHaveLength(0);
    expect(subs(tree(rows, ["h:c1:"]))).toHaveLength(0);
  });
  test("ids am would refuse and rows without a running list nest nothing", () => {
    expect(runningOf({ subagents: { active: 2, types: "Explore", detail: "" } })).toEqual([]);
    expect(runningOf({ subagents: running({ id: "bad id" }, { id: "ok" }) }).map((item) => item.id)).toEqual(["ok"]);
    expect(subs(tree([row("harbor-lights", { subagents: { active: 2, types: "Explore", detail: "2 subagents" } })]))).toHaveLength(0);
  });
  test("every Group by mode and sort keeps the nested rows right after their parent, never under Needs attention", () => {
    const rows = [
      row("harbor-lights", { status: "working", subagents: running({ id: "b8" }, { id: "c6" }) }),
      row("fog-signal", { status: "needs-attention", subagents: running({ id: "f1" }) }),
      row("kelp-forest", { host: "annex", status: "working", subagents: running({ id: "k1" }) }),
      row("keeper-log"),
    ];
    for (const group of ["tree", "status", "repo", "host"] as const) {
      for (const sort of ["status", "recent", "runtime", "name"] as const) {
        for (const reverse of [false, true]) {
          const items = nestSubagents(buildTree([{ ...fleet(rows), remoteHosts: ["annex"] }], { filter: "", showStopped: false, collapsed: new Set(), group, sort, reverse, now: Date.parse("2026-01-01T01:00:00Z") }).items);
          const nested = subs(items);
          expect(nested.map((item) => item.subagentId).sort()).toEqual(["b8", "c6", "f1", "k1"]);
          for (const sub of nested) {
            expect(sub.parent.startsWith("attention>")).toBe(false);
            const parentIndex = items.findIndex((item) => item.id === sub.parent);
            const between = items.slice(parentIndex + 1, items.indexOf(sub));
            expect(between.every((item) => item.kind === "subagent" && item.parent === sub.parent)).toBe(true);
          }
        }
      }
    }
  });
  test("itemKey keeps a cursor on the same agent or subagent across groups", () => {
    const items = tree([row("harbor-lights", { subagents: running({ id: "b8" }) })]);
    expect(items.map(itemKey).filter(Boolean)).toEqual(["c1/harbor-lights", "c1/harbor-lights#b8"]);
  });
});

describe("inspector layout and preferences", () => {
  test("docks only when the transcript keeps its minimum width", () => {
    expect(inspectorDocks({ windowWidth: 1440, sidebarWidth: 280, inspectorWidth: 300 })).toBe(true);
    expect(inspectorDocks({ windowWidth: 1000, sidebarWidth: 280, inspectorWidth: 300 })).toBe(false);
    expect(inspectorDocks({ windowWidth: 1000, sidebarWidth: 200, inspectorWidth: 240 })).toBe(true);
  });
  test("width clamps to the minimum and to 40% of the window", () => {
    expect(clampInspectorWidth(100, 1440)).toBe(INSPECTOR_MIN);
    expect(clampInspectorWidth(900, 1440)).toBe(inspectorMax(1440));
    expect(inspectorMax(1440)).toBe(520);
    expect(inspectorMax(800)).toBe(320);
    expect(inspectorMax(400)).toBe(INSPECTOR_MIN);
  });
  test("preferences round-trip and survive junk", () => {
    const prefs = { open: false, width: 360, showFinished: true };
    expect(parseInspectorPrefs(serializeInspectorPrefs(prefs))).toEqual(prefs);
    expect(parseInspectorPrefs(null)).toEqual(DEFAULT_INSPECTOR_PREFS);
    expect(parseInspectorPrefs("{")).toEqual(DEFAULT_INSPECTOR_PREFS);
    expect(parseInspectorPrefs("null")).toEqual(DEFAULT_INSPECTOR_PREFS);
    expect(parseInspectorPrefs(JSON.stringify({ open: "yes", width: 9999, showFinished: 1 }))).toEqual({ open: true, width: 520, showFinished: false });
  });
});
