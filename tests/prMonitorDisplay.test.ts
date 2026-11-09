import { describe, expect, test } from "bun:test";
import { fleetPickerItem, type FleetRow } from "../src/fleet";

const base: FleetRow = {
  name: "watcher", status: "exited", host: "server", provider: "codex", queued: 1,
  updatedAt: "2026-11-09T12:00:00.000Z", dir: "/tmp/project",
};

describe("PR monitor picker details", () => {
  test("shows remote tracked PR state, abbreviated merge SHA and refresh errors", () => {
    const item = fleetPickerItem({ ...base, prMonitor: {
      pullRequests: [{
        repository: "owner/repo", number: 42, url: "https://github.com/owner/repo/pull/42",
        state: "MERGED", mergeCommit: "abcdef1234567890", updatedAt: base.updatedAt,
      }],
      error: "GitHub unavailable",
    } });
    expect(item.name).toBe("server:watcher");
    expect(item.meta).toContain("pr       PR #42 MERGED abcdef1 · owner/repo");
    expect(item.meta).toContain("pr-check GitHub unavailable");
    expect(item.queueDepth).toBe(1);
  });

  test("bounds the detail card height for large stacks", () => {
    const item = fleetPickerItem({ ...base, prMonitor: {
      pullRequests: Array.from({ length: 10 }, (_, i) => ({
        repository: "owner/repo", number: i + 1, url: `https://github.com/owner/repo/pull/${i + 1}`,
        state: "OPEN", updatedAt: base.updatedAt,
      })),
    } });
    expect(item.meta?.filter((line) => line.startsWith("pr "))).toHaveLength(3);
    expect(item.meta).toContain("prs      +7 more");
  });

  test("does not add detail rows for agents without tracked PRs", () => {
    for (const row of [base, { ...base, prMonitor: { pullRequests: [] } }]) {
      expect(fleetPickerItem(row).meta?.some((line) => /^pr(?:s|-check)?\s/.test(line))).toBe(false);
    }
  });
});
