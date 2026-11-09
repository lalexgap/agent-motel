import { describe, expect, test } from "bun:test";
import type { Fleet, FleetRow } from "../src/fleet";
import { buildFleetSummary, formatFleetSummary, STALE_STARTING_SECONDS } from "../src/summary";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function row(name: string, status: FleetRow["status"], overrides: Partial<FleetRow> = {}): FleetRow {
  return {
    name,
    status,
    provider: "claude",
    queued: 0,
    updatedAt: "2026-07-22T11:59:30.000Z",
    statusChangedAt: "2026-07-22T11:59:30.000Z",
    dir: "/tmp",
    ...overrides,
  };
}

describe("fleet summary", () => {
  test("prioritizes attention, then separates active, idle, and exited agents", () => {
    const fleet: Fleet = {
      rows: [
        row("worker", "working", { task: "implement the reporting view" }),
        row("blocked", "needs-attention", { statusReason: "approval requested — shell" }),
        row("watcher", "waiting", { statusDetail: "next wake-up in 4m" }),
        row("quiet", "idle"),
        row("done", "exited"),
      ],
      unreachable: ["build-box"],
    };

    const summary = buildFleetSummary(fleet, NOW);
    expect(summary.attention.map((item) => item.status)).toEqual(["needs-attention", "unreachable"]);
    expect(summary.attention[0]?.reason).toBe("approval requested — shell");
    expect(summary.active.map((item) => item.name)).toEqual(["worker", "watcher"]);
    expect(summary.active.find((item) => item.name === "watcher")?.reason).toBe("next wake-up in 4m");
    expect(summary.idle.map((item) => item.name)).toEqual(["quiet"]);
    expect(summary.exited.map((item) => item.name)).toEqual(["done"]);
  });

  test("promotes an agent stuck in starting to attention", () => {
    const changedAt = new Date(NOW.getTime() - STALE_STARTING_SECONDS * 1000).toISOString();
    const summary = buildFleetSummary({
      rows: [row("stuck", "starting", { statusChangedAt: changedAt })],
      unreachable: [],
    }, NOW);

    expect(summary.active).toHaveLength(0);
    expect(summary.attention[0]).toMatchObject({ name: "stuck", status: "starting" });
    expect(summary.attention[0]?.reason).toContain("still starting after 2m");
  });

  test("uses host-qualified keys and renders queue depth", () => {
    const summary = buildFleetSummary({
      rows: [row("remote-worker", "working", { host: "server", queued: 2 })],
      unreachable: [],
    }, NOW);
    const text = formatFleetSummary(summary).join("\n");
    expect(text).toContain("server:remote-worker");
    expect(text).toContain("2 queued");
  });

  test("carries roles into JSON and the human report", () => {
    const summary = buildFleetSummary({
      rows: [row("audit", "working", { role: "security-reviewer" })],
      unreachable: [],
    }, NOW);
    expect(summary.active[0]?.role).toBe("security-reviewer");
    expect(formatFleetSummary(summary).join("\n")).toContain("working · security-reviewer");
  });

  test("collapses historical exited agents in the human report", () => {
    const summary = buildFleetSummary({
      rows: [row("old-agent", "exited"), row("current", "working")],
      unreachable: [],
    }, NOW);
    const text = formatFleetSummary(summary).join("\n");
    expect(text).toContain("Exited (1)");
    expect(text).not.toContain("old-agent");
  });

  test("renders an empty fleet tersely", () => {
    expect(formatFleetSummary(buildFleetSummary({ rows: [], unreachable: [] }, NOW))).toEqual(["No agents."]);
  });

  test("preserves complete PR monitor metadata across remote summary JSON", () => {
    const prMonitor = {
      pullRequests: [{
        repository: "owner/repo", number: 42, url: "https://github.com/owner/repo/pull/42",
        state: "MERGED" as const, mergedAt: NOW.toISOString(),
        mergeCommit: "abcdef1234567890", updatedAt: NOW.toISOString(),
      }],
      checkedAt: NOW.toISOString(),
      error: "refresh failed",
    };
    const summary = buildFleetSummary({
      rows: JSON.parse(JSON.stringify([row("watcher", "idle", { host: "server", prMonitor })])),
      unreachable: [],
    }, NOW);
    const json = JSON.parse(JSON.stringify(summary));
    expect(json.idle[0].prMonitor).toEqual(prMonitor);
    expect(json.idle[0].key).toBe("server:watcher");
    expect(formatFleetSummary(summary).join("\n")).toContain("PR #42 MERGED abcdef1");
  });

  test("renders every tracked PR state without inventing a merge SHA", () => {
    const summary = buildFleetSummary({
      rows: [row("stack", "working", {
        prMonitor: { pullRequests: ["OPEN", "CLOSED", "MERGED"].map((state, index) => ({
          repository: "owner/repo", number: index + 1,
          url: `https://github.com/owner/repo/pull/${index + 1}`,
          state: state as "OPEN" | "CLOSED" | "MERGED", updatedAt: NOW.toISOString(),
          ...(state === "CLOSED" ? { mergeCommit: "ignored" } : {}),
        })) },
      })],
      unreachable: [],
    }, NOW);
    const text = formatFleetSummary(summary).join("\n");
    expect(text).toContain("PR #1 OPEN · PR #2 CLOSED · PR #3 MERGED");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("ignored");
  });

  test("shows local and remote exited PR follow-ups without flooding historical exits", () => {
    const prMonitor = { pullRequests: [{
      repository: "owner/repo", number: 42, url: "https://github.com/owner/repo/pull/42",
      state: "MERGED" as const, mergeCommit: "abcdef1234567890", updatedAt: NOW.toISOString(),
    }] };
    const summary = buildFleetSummary({
      rows: [
        row("pending-local", "exited", { prMonitor, queued: 1 }),
        row("pending-remote", "exited", { prMonitor, queued: 2, host: "server" }),
        row("delivered", "exited", { prMonitor }),
        row("unrelated-queue", "exited", { queued: 1 }),
        row("empty-monitor", "exited", { queued: 1, prMonitor: { pullRequests: [] } }),
        ...Array.from({ length: 100 }, (_, i) => row(`historical-${i}`, "exited")),
      ],
      unreachable: [],
    }, NOW);
    const text = formatFleetSummary(summary).join("\n");
    expect(text).toContain("Fleet: 105 agents");
    expect(text).toContain("Exited with queued messages (2)");
    expect(text).toContain("pending-local");
    expect(text).toContain("server:pending-remote");
    expect(text).toContain("PR #42 MERGED abcdef1 · 2 queued");
    expect(text).toContain("Exited (103)");
    for (const hidden of ["delivered", "unrelated-queue", "empty-monitor", "historical-"]) {
      expect(text).not.toContain(hidden);
    }
    expect(summary.exited).toHaveLength(105);
    expect(JSON.parse(JSON.stringify(summary)).exited.find((item: { name: string }) => item.name === "delivered").prMonitor).toEqual(prMonitor);
  });

  test("omits PR metadata for older hosts and handles an empty monitor", () => {
    const summary = buildFleetSummary({
      rows: [row("legacy", "idle", { host: "old-server" }), row("empty", "idle", { prMonitor: { pullRequests: [] } })],
      unreachable: [],
    }, NOW);
    expect(JSON.parse(JSON.stringify(summary)).idle.find((item: { name: string }) => item.name === "legacy")).not.toHaveProperty("prMonitor");
    expect(formatFleetSummary(summary).join("\n")).not.toContain("PR #");
  });
});
