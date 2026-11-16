import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { AgentRow } from "../desktop/src/types";
import { workingAnchor, workingIndicator, workingText } from "../desktop/src/working";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const row = (overrides: Partial<AgentRow> = {}): Partial<AgentRow> => ({
  status: "working",
  statusChangedAt: at(-30_000),
  ...overrides,
});

describe("workingAnchor", () => {
  test("prefers valid working, prompt, then status transition timestamps", () => {
    expect(workingAnchor(row({ workingSince: at(-10_000), promptAt: at(-20_000) }))).toBe(NOW - 10_000);
    expect(workingAnchor(row({ workingSince: "bad", promptAt: at(-20_000) }))).toBe(NOW - 20_000);
    expect(workingAnchor(row({ workingSince: "bad", promptAt: "also bad" }))).toBe(NOW - 30_000);
  });

  test("starting and derived subagent waits use their status transition", () => {
    expect(workingAnchor(row({ status: "starting", promptAt: at(-300_000) }))).toBe(NOW - 30_000);
    expect(workingAnchor(row({ status: "working", rawStatus: "idle", busyWith: { subagents: 1, background: 0 }, workingSince: at(-300_000) }))).toBe(NOW - 30_000);
    expect(workingAnchor(row({ status: "working", busyWith: { subagents: 1, background: 0 }, workingSince: at(-300_000) }))).toBe(NOW - 30_000);
  });

  test("a new prompt supersedes the prior status transition when workingSince is absent", () => {
    expect(workingAnchor(row({ statusChangedAt: at(-300_000), promptAt: at(-5_000), workingSince: null }))).toBe(NOW - 5_000);
  });

  test("missing and invalid anchors are unknown", () => {
    expect(workingAnchor(row({ statusChangedAt: "bad", promptAt: null, workingSince: null }))).toBeUndefined();
    expect(workingAnchor(row({ status: "idle" }))).toBeUndefined();
  });
});

describe("workingText", () => {
  test("keeps unknown, future, and sub-two-second work unsettled", () => {
    expect(workingText("Working", undefined, NOW)).toBe("Working…");
    expect(workingText("Working", NOW + 1, NOW)).toBe("Working…");
    expect(workingText("Working", NOW - 1_999, NOW)).toBe("Working…");
    expect(workingText("Working", Number.NaN, NOW)).toBe("Working…");
    expect(workingText("Working", Number.POSITIVE_INFINITY, NOW)).toBe("Working…");
    expect(workingText("Working", NOW - 2_000, Number.NaN)).toBe("Working…");
  });

  test("formats seconds, minutes, and hours at their thresholds", () => {
    expect(workingText("Working", NOW - 2_000, NOW)).toBe("Working · 2s");
    expect(workingText("Working", NOW - 12_900, NOW)).toBe("Working · 12s");
    expect(workingText("Working", NOW - 65_000, NOW)).toBe("Working · 1m 05s");
    expect(workingText("Working", NOW - 3_900_000, NOW)).toBe("Working · 1h 05m");
  });
});

describe("workingIndicator", () => {
  test("names one known running subagent and otherwise uses the count", () => {
    const one = row({ rawStatus: "idle", busyWith: { subagents: 1, background: 0 }, subagents: { running: [{ id: "s1", type: "shepherd" }] } });
    expect(workingIndicator(one, NOW)).toMatchObject({ label: "Waiting on shepherd", text: "Waiting on shepherd · 30s", attention: false });
    const many = row({ rawStatus: "idle", busyWith: { subagents: 2, background: 0 }, subagents: { running: [{ id: "s1", type: "reviewer" }] } });
    expect(workingIndicator(many, NOW)?.label).toBe("Waiting on 2 subagents");
    expect(workingIndicator(row({ busyWith: { subagents: 1, background: 0 } }), NOW)?.label).toBe("Waiting on 1 subagent");
    expect(workingIndicator(row({ status: "starting", busyWith: { subagents: 1, background: 0 } }), NOW)?.label).toBe("Starting");
    expect(workingIndicator(row({ status: "waiting", busyWith: { subagents: 1, background: 0 } }), NOW)?.label).toBe("Waiting on background tasks");
  });

  test("attention prompts and decisions override timers", () => {
    expect(workingIndicator(row({ status: "needs-attention", statusReason: "approval requested — shell" }), NOW)).toEqual({
      label: "approval requested — shell", text: "approval requested — shell", attention: true,
    });
    expect(workingIndicator(row({ status: "needs-attention", statusReason: "" }), NOW)?.text).toBe("Needs attention");
    expect(workingIndicator(row({ status: "needs-attention", statusReason: "Approve the command", blockingDecisions: 1 }), NOW)?.text).toBe("Approve the command");
    expect(workingIndicator(row({ blockingDecisions: 1 }), NOW)).toEqual({
      label: "Waiting for your answer", text: "Waiting for your answer", attention: true,
    });
  });

  test("hides settled agents without a blocker", () => {
    for (const status of ["idle", "dead", "exited"] as const) expect(workingIndicator(row({ status }), NOW)).toBeNull();
    expect(workingIndicator(row({ status: "idle", rawStatus: "idle", busyWith: { subagents: 1, background: 0 } }), NOW)).toBeNull();
    expect(workingIndicator(row({ status: "idle", blockingDecisions: 1 }), NOW)?.attention).toBe(true);
  });

  test("recomputes elapsed text from a stable anchor without a new event", () => {
    const subject = row({ workingSince: at(-2_000) });
    expect(workingIndicator(subject, NOW)?.text).toBe("Working · 2s");
    expect(workingIndicator(subject, NOW + 10_000)?.text).toBe("Working · 12s");
  });
});


test("a fresher detail keeps fleet-only blockers and subagent names", () => {
  const source = readFileSync(new URL("../desktop/src/state.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function agentSource(");
  const end = source.indexOf("export function agentComposer(", start);
  const fleet = row({ updatedAt: at(-10_000), blockingDecisions: 1, busyWith: { subagents: 1, background: 0 }, subagents: { running: [{ id: "s1", type: "reviewer" }] } });
  const detail = row({ updatedAt: at(-1_000), workingSince: at(-5_000) });
  const context: any = { findRow: () => fleet, state: { detail: { key: "agent", detail } } };
  runInNewContext(source.slice(start, end).replace("export function agentSource(key: string): Partial<AgentRow>", "function agentSource(key)"), context);
  const selected = context.agentSource("agent");
  expect(selected.workingSince).toBe(detail.workingSince);
  expect(workingIndicator(selected, NOW)?.text).toBe("Waiting for your answer");
  fleet.blockingDecisions = 0;
  expect(workingIndicator(context.agentSource("agent"), NOW)?.label).toBe("Waiting on reviewer");
});
