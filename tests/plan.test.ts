import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs, planFile, trashDir } from "../src/paths";
import {
  ensurePlan,
  planContext,
  planHead,
  planIsStale,
  planNudge,
  planPromptNotes,
  planTemplate,
  planWanted,
  restorePlan,
  trashPlan,
} from "../src/plan";

describe("planTemplate", () => {
  test("holds the task and the empty sections", () => {
    const text = planTemplate("api", "fix the login bug", "2026-11-02T00:00:00.000Z");
    expect(text.startsWith("# Plan: api\n")).toBe(true);
    for (const heading of ["## Task", "## Goal", "## Current status", "## Next steps", "## Decisions", "## Notes"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("fix the login bug");
    expect(text).toMatch(/## Current status\n\nnot started\n/);
  });

  test("caps a long task and says so", () => {
    const text = planTemplate("api", "x".repeat(5000), "now");
    expect(text).toContain("x".repeat(4000));
    expect(text).not.toContain("x".repeat(4001));
    expect(text).toContain("(task truncated at 4000 characters)");
  });
});

describe("planHead", () => {
  test("short plans pass through untouched", () => {
    expect(planHead("# Plan\n\nhi\n")).toBe("# Plan\n\nhi");
  });

  test("cuts at the line cap and says so", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const head = planHead(text, { maxLines: 80, maxBytes: 6000 });
    expect(head.split("\n")).toHaveLength(81);
    expect(head).toContain("line 79");
    expect(head).not.toContain("line 80");
    expect(head.endsWith("… (truncated; read the file for the rest)")).toBe(true);
  });

  test("cuts at the byte cap on a line boundary", () => {
    const text = Array.from({ length: 50 }, () => "é".repeat(100)).join("\n");
    const head = planHead(text, { maxLines: 80, maxBytes: 6000 });
    const body = head.slice(0, head.lastIndexOf("\n"));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(6000);
    expect(body.split("\n").every((line) => line === "é".repeat(100))).toBe(true);
    expect(head).toContain("(truncated; read the file for the rest)");
  });
});

describe("plan context and nudge", () => {
  test("context names the path, then the head", () => {
    const out = planContext("api", "/p/api.md", "# Plan: api");
    expect(out.startsWith("[am plan] Your running plan for this task is /p/api.md.")).toBe(true);
    expect(out).toContain("injected once per session, not on every turn.\n\n# Plan: api");
  });

  test("nudge is one line", () => {
    const out = planNudge("/p/api.md");
    expect(out).not.toContain("\n");
    expect(out).toContain("/p/api.md was not updated during your last long turn");
  });
});

describe("planIsStale", () => {
  const since = "2026-11-02T10:00:00.000Z";
  const before = Date.parse(since) - 1000;
  const after = Date.parse(since) + 1000;
  test("long turn that never touched the plan", () => {
    expect(planIsStale(before, since, 600)).toBe(true);
  });
  test("short turns, updated plans and unknown starts are not stale", () => {
    expect(planIsStale(before, since, 120)).toBe(false);
    expect(planIsStale(after, since, 600)).toBe(false);
    expect(planIsStale(before, undefined, 600)).toBe(false);
    expect(planIsStale(before, since, 60, 30)).toBe(true);
  });
});

describe("plan files", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-plan-"));
    process.env.AGENTMGR_HOME = home;
    ensureDirs();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  test("ensurePlan creates once and never overwrites", () => {
    const path = ensurePlan("api", "first task");
    expect(path).toBe(planFile("api"));
    writeFileSync(path, "edited by the agent");
    ensurePlan("api", "second task");
    expect(readFileSync(path, "utf8")).toBe("edited by the agent");
  });

  test("ensurePlan can seed from another plan", () => {
    writeFileSync(planFile("src"), "# Plan: src\n\nhalfway");
    ensurePlan("dst", "ignored", { from: planFile("src") });
    expect(readFileSync(planFile("dst"), "utf8")).toBe("# Plan: src\n\nhalfway");
  });

  test("housekeeping roles, --no-plan and config.plans=false get none", () => {
    expect(planWanted({})).toBe(true);
    expect(planWanted({ role: "concierge" })).toBe(false);
    expect(planWanted({ role: "caretaker" })).toBe(false);
    expect(planWanted({ noPlan: true })).toBe(false);
    writeFileSync(join(home, "config.json"), JSON.stringify({ plans: false }));
    expect(planWanted({})).toBe(false);
  });

  test("prompt notes: head when pending, nudge otherwise, nothing without a file", () => {
    expect(planPromptNotes({ name: "api", planPending: true })).toEqual([]);
    ensurePlan("api", "task");
    expect(planPromptNotes({ name: "api" })).toEqual([]);
    const [context] = planPromptNotes({ name: "api", planPending: true, planNudge: true });
    expect(context).toContain("# Plan: api");
    expect(planPromptNotes({ name: "api", planNudge: true })).toEqual([planNudge(planFile("api"))]);
  });

  test("trash and restore round-trip", () => {
    ensurePlan("api", "task");
    trashPlan("api");
    expect(existsSync(planFile("api"))).toBe(false);
    expect(existsSync(join(trashDir(), "api.plan.md"))).toBe(true);
    restorePlan("api");
    expect(readFileSync(planFile("api"), "utf8")).toContain("# Plan: api");
  });
});
