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

  test("rejects a plans directory symlink even when its files resolve cleanly", () => {
    const root = home();
    const outside = join(root, "outside");
    rmSync(join(root, "plans"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "worker.md"), plan("outside secret"));
    symlinkSync(outside, join(root, "plans"));

    expect(readPlanProjection("worker")).toMatchObject({ state: "unavailable", reason: "unsafe-path" });
    expect(readPlanProjection("worker")).not.toHaveProperty("currentStatus");
  });

  test("a FIFO replacement during open is rejected without blocking", () => {
    const script = `
      import assert from "node:assert/strict";
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const actualOpenSync = fs.openSync;
      const root = process.env.AGENTMGR_HOME;
      const target = root + "/plans/worker.md";
      fs.mkdirSync(root + "/plans", { recursive: true });
      fs.writeFileSync(target, ${JSON.stringify(plan())});
      let swapped = false;
      mock.module("node:fs", () => ({
        ...fs,
        openSync(path, flags, mode) {
          if (!swapped && path === target) {
            swapped = true;
            fs.unlinkSync(target);
            const made = Bun.spawnSync(["mkfifo", target]);
            assert.equal(made.exitCode, 0);
          }
          return actualOpenSync(path, flags, mode);
        },
      }));
      const { readPlanProjection } = await import("./src/planProjection.ts?fifo-transition");
      assert.deepEqual(readPlanProjection("worker"), {
        source: "legacy-plan", state: "unavailable", freshness: "unknown", reason: "unsafe-path",
      });
    `;
    const root = home();
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, AGENTMGR_HOME: root },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2_000,
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
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
