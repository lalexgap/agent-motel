import { describe, expect, test } from "bun:test";
import { cleanupBlocked, cleanupCanApply, cleanupForceable, parseCleanupPlan } from "../desktop/src/cleanup";

const plan = {
  name: "harbor-lights",
  createdAt: "2026-11-17T10:00:00.000Z",
  token: "a".repeat(64),
  remove: ["/tmp/am/harbor-lights", "private.sqlite"],
  keep: ["branch cleanup-ui", "PR #42"],
  blockers: [],
  branch: "cleanup-ui",
  prs: ["#42"],
};

describe("cleanup preview policy", () => {
  test("accepts the complete server plan only for the requested agent", () => {
    expect(parseCleanupPlan(plan, "harbor-lights")).toEqual(plan);
    expect(parseCleanupPlan(plan, "laptop:harbor-lights")).toEqual(plan);
    expect(parseCleanupPlan(plan, "other-agent")).toBeNull();
    for (const invalid of [
      { ...plan, createdAt: null },
      { ...plan, token: "" },
      { ...plan, remove: ["ok", 7] },
      { ...plan, branch: 7 },
      { ...plan, blockers: [{ reason: "dirty worktree", forceable: "yes" }] },
      { ...plan, prs: null },
    ]) expect(parseCleanupPlan(invalid, "harbor-lights")).toBeNull();
  });

  test("requires review, and a second acknowledgement before force", () => {
    expect(cleanupCanApply(plan, false, false)).toBe(false);
    expect(cleanupCanApply(plan, true, false)).toBe(true);
    const forceable = { ...plan, blockers: [{ reason: "uncommitted changes", forceable: true }] };
    expect(cleanupForceable(forceable)).toBe(true);
    expect(cleanupCanApply(forceable, true, false)).toBe(false);
    expect(cleanupCanApply(forceable, true, true)).toBe(true);
    const blocked = { ...plan, blockers: [{ reason: "agent is still running", forceable: false }] };
    expect(cleanupBlocked(blocked)).toBe(true);
    expect(cleanupCanApply(blocked, true, true)).toBe(false);
  });
});
