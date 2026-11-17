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
