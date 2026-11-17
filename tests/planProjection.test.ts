import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  parseLegacyPlanProjection,
  PLAN_PROJECTION_FILE_MAX_BYTES,
  PLAN_PROJECTION_SECTION_MAX_BYTES,
  readPlanProjection,
  resetPlanProjectionCacheForTests,
} from "../src/planProjection";

const roots: string[] = [];
afterEach(() => {
  delete process.env.AGENTMGR_HOME;
  resetPlanProjectionCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "am-plan-projection-"));
  roots.push(root);
  process.env.AGENTMGR_HOME = root;
  mkdirSync(join(root, "plans"), { recursive: true });
  return root;
}

function plan(current = "Implementing the status panel", next = "- Add tests"): string {
  return `# Plan: worker\n\n## Task\n\nOriginal task\n\n## Current status\n\n${current}\n\n## Next steps\n\n${next}\n\n## Notes\n\nHistory\n`;
}

describe("legacy plan projection", () => {
  test("extracts bounded current status and next steps with unknown freshness", () => {
    const parsed = parseLegacyPlanProjection(plan("x".repeat(PLAN_PROJECTION_SECTION_MAX_BYTES + 50)), "2026-11-17T00:00:00.000Z");
    expect(parsed).toMatchObject({ source: "legacy-plan", state: "available", freshness: "unknown", modifiedAt: "2026-11-17T00:00:00.000Z" });
    expect(Buffer.byteLength(parsed.currentStatus!)).toBeLessThanOrEqual(PLAN_PROJECTION_SECTION_MAX_BYTES);
    expect(parsed.currentStatus).toEndWith("…");
    expect(parsed.nextSteps).toBe("- Add tests");
  });

  test("does not treat headings inside fenced examples as duplicates", () => {
    const parsed = parseLegacyPlanProjection(plan("Working\n\n```md\n## Current status\nnot real\n```"));
    expect(parsed.state).toBe("available");
  });

  test("recognizes dated em-dash heading suffixes and normalizes them for duplicate checks", () => {
    const dated = plan().replace("## Current status", "## Current status — 2026-11-17 ~16:36 UTC")
      .replace("## Next steps", "## Next steps — Jev FIRST, Postgres PAUSED");
    expect(parseLegacyPlanProjection(dated)).toMatchObject({ state: "available", currentStatus: "Implementing the status panel" });
    expect(parseLegacyPlanProjection(dated + "\n## Current status\nAgain\n")).toMatchObject({ state: "invalid", reason: "duplicate-headings" });
  });

  test("labels placeholders, duplicate headings and missing headings honestly", () => {
    expect(parseLegacyPlanProjection(plan("not started", "-")).state).toBe("placeholder");
    expect(parseLegacyPlanProjection(plan() + "\n## Current status\nSecond\n")).toMatchObject({ state: "invalid", reason: "duplicate-headings" });
    expect(parseLegacyPlanProjection("## Current status\nWorking\n")).toMatchObject({ state: "invalid", reason: "missing-headings" });
  });

  test("reads only the validated agent identity and rejects traversal and symlinks", () => {
    const root = home();
    writeFileSync(join(root, "plans", "worker.md"), plan());
    writeFileSync(join(root, "secret.md"), plan("secret"));
    symlinkSync(join(root, "secret.md"), join(root, "plans", "linked.md"));

    expect(readPlanProjection("worker")).toMatchObject({ state: "available", currentStatus: "Implementing the status panel" });
    expect(readPlanProjection("../secret")).toMatchObject({ state: "unavailable", reason: "unsafe-path" });
    expect(readPlanProjection("linked")).toMatchObject({ state: "unavailable", reason: "unsafe-path" });
    expect(readPlanProjection("absent")).toMatchObject({ state: "missing" });
  });

  test("refuses a large plan without reading or projecting its contents", () => {
    const root = home();
    writeFileSync(join(root, "plans", "large.md"), plan("secret") + "x".repeat(PLAN_PROJECTION_FILE_MAX_BYTES));
    expect(readPlanProjection("large")).toMatchObject({ state: "invalid", reason: "too-large", freshness: "unknown" });
    expect(readPlanProjection("large")).not.toHaveProperty("currentStatus");
  });

  test("invalidates the cache when the plan changes", async () => {
    const root = home();
    const path = join(root, "plans", "worker.md");
    writeFileSync(path, plan("First"));
    expect(readPlanProjection("worker").currentStatus).toBe("First");
    await Bun.sleep(5);
    writeFileSync(path, plan("Second and longer"));
    expect(readPlanProjection("worker").currentStatus).toBe("Second and longer");
  });
});
