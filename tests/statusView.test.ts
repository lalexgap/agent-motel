import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { projectionMessage, statusSummary } from "../desktop/src/statusModel";
import type { AgentRow, PlanProjection } from "../desktop/src/types";

const projection = (state: PlanProjection["state"], extra: Partial<PlanProjection> = {}): PlanProjection =>
  ({ source: "legacy-plan", state, freshness: "unknown", ...extra });
const row = (statusProjection?: PlanProjection, task = "Original task"): Partial<AgentRow> => ({ statusProjection, task });

describe("status view model", () => {
  test("uses current status for summaries and labels every task fallback", () => {
    expect(statusSummary(row(projection("available", { currentStatus: "Working on parser\nMore detail" })))).toBe("Working on parser");
    expect(statusSummary(row(projection("missing")))).toBe("Original task: Original task");
    expect(statusSummary(row(projection("placeholder")))).toBe("Plan says not started · Original task: Original task");
    expect(statusSummary(row(undefined))).toBe("Status unavailable on this host");
  });

  test("explains unsafe, duplicate, large and old-host states without exposing paths", () => {
    expect(projectionMessage(projection("unavailable", { reason: "unsafe-path" }))).toContain("unsafe");
    expect(projectionMessage(projection("invalid", { reason: "duplicate-headings" }))).toContain("duplicate");
    expect(projectionMessage(projection("invalid", { reason: "too-large" }))).toContain("too large");
    expect(projectionMessage(undefined)).toContain("does not provide");
  });

  test("web and desktop sidebar summaries stay in parity", () => {
    const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    const start = source.indexOf("function statusSummary(row)");
    const end = source.indexOf("function observationAge", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const context: Record<string, unknown> = {};
    runInNewContext(source.slice(start, end) + ";this.statusSummary = statusSummary;", context);
    const web = context.statusSummary as (value: Partial<AgentRow>) => string;
    for (const value of [
      row(projection("available", { currentStatus: "Current\nDetails" })), row(projection("missing")),
      row(projection("placeholder")), row(projection("invalid", { reason: "too-large" })), row(undefined),
    ]) expect(web(value)).toBe(statusSummary(value));
  });
});

test("both frontends expose stable status screenshot selectors", () => {
  const web = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("../desktop/src/statusSection.ts", import.meta.url), "utf8");
  expect(web).toContain('class="agent-status-panel"');
  expect(web).toContain('id="agent-status-signals"');
  expect(desktop).toContain('registerInspectorSection({ id: "status"');
});

test("desktop keeps bounded fleet polling while the event stream is healthy", () => {
  const source = readFileSync(new URL("../desktop/src/data.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function poll(now: number)");
  expect(start).toBeGreaterThanOrEqual(0);
  const loaded: string[] = [];
  const connection = { conn: { id: "home" }, stream: "open", agentsFetchedAt: 0 };
  const context = {
    state: { conns: new Map([["home", connection]]), selected: null, detail: null, detailInFlight: false, detailFetchedAt: 0 },
    loadAgents: async (id: string) => { loaded.push(id); },
    loadDetail: async () => {},
    findRow: () => null,
    parseAgentKey: () => null,
    agentComposer: () => ({ pending: [] }),
    BUSY: new Set(),
    FLEET_POLL_MS: 5_000,
    DETAIL_POLL_MS: 4_000,
  };
  runInNewContext(source.slice(start).replace("export function poll(now: number): void", "function poll(now)") + ";this.poll = poll;", context);
  (context as typeof context & { poll: (now: number) => void }).poll(4_999);
  expect(loaded).toEqual([]);
  (context as typeof context & { poll: (now: number) => void }).poll(5_000);
  expect(loaded).toEqual(["home"]);
});

test("web reapplies a fresh fleet projection when detail finishes first", async () => {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const statusStart = source.indexOf("function renderSelectedAgentStatus()");
  const statusEnd = source.indexOf("async function refreshDetail()", statusStart);
  const refreshStart = source.indexOf("async function refresh()", statusEnd);
  const refreshEnd = source.indexOf("async function loadModels()", refreshStart);
  expect(statusStart).toBeGreaterThanOrEqual(0);
  expect(statusEnd).toBeGreaterThan(statusStart);
  expect(refreshStart).toBeGreaterThan(statusEnd);
  expect(refreshEnd).toBeGreaterThan(refreshStart);

  const stale = projection("available", { currentStatus: "Old plan" });
  const fresh = projection("available", { currentStatus: "Fresh plan" });
  const rendered: string[] = [];
  const state = {
    authenticated: true, refreshing: false, refreshPending: false, selected: "worker", rows: [{ name: "worker", statusProjection: stale }],
    detailCapabilities: { name: "worker", detail: { name: "worker", statusProjection: stale } }, noticeSource: null,
  };
  const context = {
    state,
    key: (value: { name: string }) => value.name,
    renderAgentStatus: (value: { statusProjection?: PlanProjection }) => rendered.push(value.statusProjection?.currentStatus || "missing"),
    refreshWorkspace: () => {}, refreshDock: async () => {}, refreshSubagent: async () => {}, refreshUsageSummary: async () => {},
    refreshPrs: async () => {}, refreshDecisionInbox: async () => {}, renderFleet: () => {}, scheduleRefresh: () => {}, notice: () => {},
    refreshDetail: async () => { (context as any).renderSelectedAgentStatus(); },
    api: async () => ({ rows: [{ name: "worker", statusProjection: fresh }], unreachable: [] }),
    $: () => ({ hidden: true, textContent: "" }),
  };
  runInNewContext(
    source.slice(statusStart, statusEnd) + source.slice(refreshStart, refreshEnd) + ";this.renderSelectedAgentStatus = renderSelectedAgentStatus; this.refresh = refresh;",
    context,
  );
  await (context as typeof context & { refresh: () => Promise<void> }).refresh();
  expect(rendered).toEqual(["Old plan", "Fresh plan"]);
});
