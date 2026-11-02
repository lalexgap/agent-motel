import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeOAuth,
  fetchClaudeUsage,
  formatResetIn,
  formatUsageBadge,
  formatUsageReport,
  formatWindowMinutes,
  isStale,
  parseClaudeUsage,
  parseCodexRateLimits,
  readClaudeCredentials,
  readClaudeUsageCache,
  readCodexUsage,
  usageBar,
  usageLevel,
  usagePollDelay,
  type UsageReport,
} from "../src/usage";

describe("parseClaudeUsage", () => {
  test("maps the metered windows and skips unreleased buckets", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 11, resets_at: "2026-08-17T20:19:59+00:00" },
      seven_day: { utilization: 75, resets_at: "2026-08-17T17:59:59+00:00" },
      seven_day_opus: null,
      // Codenamed buckets for features that aren't shipped: not our business.
      nimbus_quill: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, utilization: null },
    }, "max");
    expect(usage.plan).toBe("max");
    expect(usage.windows).toEqual([
      { label: "5h", utilization: 11, resetsAt: "2026-08-17T20:19:59+00:00" },
      { label: "week", utilization: 75, resetsAt: "2026-08-17T17:59:59+00:00" },
    ]);
  });

  test("includes extra usage only once enabled", () => {
    const usage = parseClaudeUsage({ extra_usage: { is_enabled: true, utilization: 4 } });
    expect(usage.windows).toEqual([{ label: "extra usage", utilization: 4 }]);
  });

  test("a non-object payload is an error, not a crash", () => {
    expect(parseClaudeUsage(null).error).toBeTruthy();
  });
});

describe("parseCodexRateLimits", () => {
  test("reads primary and secondary windows", () => {
    const snapshot = parseCodexRateLimits({
      primary: { used_percent: 16, window_minutes: 10080, resets_at: 1787240847 },
      secondary: { used_percent: 3, window_minutes: 300, resets_at: 1787240000 },
      plan_type: "prolite",
    }, "2026-08-17T16:54:40.576Z");
    expect(snapshot?.plan).toBe("prolite");
    expect(snapshot?.observedAt).toBe("2026-08-17T16:54:40.576Z");
    expect(snapshot?.windows).toEqual([
      { label: "week", utilization: 16, resetsAt: new Date(1787240847 * 1000).toISOString() },
      { label: "5h", utilization: 3, resetsAt: new Date(1787240000 * 1000).toISOString() },
    ]);
  });

  test("a block with no usable window yields nothing", () => {
    expect(parseCodexRateLimits({ primary: null, secondary: null }, "now")).toBeNull();
    expect(parseCodexRateLimits(undefined, "now")).toBeNull();
  });
});

describe("readCodexUsage", () => {
  let home: string;
  let previousCodexHome: string | undefined;

  const writeSession = (name: string, lines: string[]) => {
    const dir = join(home, "sessions", "2026", "08", "17");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), lines.join("\n") + "\n");
  };

  const snapshot = (timestamp: string, usedPercent: number) => JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1787240847 }, plan_type: "prolite" },
    },
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-codex-"));
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  test("takes the newest snapshot across sessions, not the newest file", () => {
    writeSession("rollout-a.jsonl", [snapshot("2026-08-17T10:00:00.000Z", 5)]);
    writeSession("rollout-b.jsonl", [snapshot("2026-08-17T16:00:00.000Z", 16)]);
    // Written last, but its reading is older — recency of the measurement wins.
    writeSession("rollout-c.jsonl", [snapshot("2026-08-17T12:00:00.000Z", 9)]);
    const usage = readCodexUsage();
    expect(usage.windows).toEqual([
      { label: "week", utilization: 16, resetsAt: new Date(1787240847 * 1000).toISOString() },
    ]);
    expect(usage.observedAt).toBe("2026-08-17T16:00:00.000Z");
  });

  test("the last snapshot in a log wins", () => {
    writeSession("rollout-a.jsonl", [
      snapshot("2026-08-17T10:00:00.000Z", 5),
      JSON.stringify({ timestamp: "2026-08-17T10:01:00.000Z", type: "event_msg", payload: { type: "agent_message" } }),
      snapshot("2026-08-17T11:00:00.000Z", 12),
    ]);
    expect(readCodexUsage().windows[0]!.utilization).toBe(12);
  });

  test("a trailing null-limits event doesn't discard the readings behind it", () => {
    // Codex writes token_count events with "rate_limits":null; ending a
    // session on one must not make the whole log invisible.
    writeSession("rollout-a.jsonl", [
      snapshot("2026-08-17T10:00:00.000Z", 12),
      JSON.stringify({
        timestamp: "2026-08-17T10:05:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", rate_limits: null },
      }),
    ]);
    const usage = readCodexUsage();
    expect(usage.windows[0]!.utilization).toBe(12);
    expect(usage.observedAt).toBe("2026-08-17T10:00:00.000Z");
  });

  test("explains itself when codex has never reported limits", () => {
    writeSession("rollout-a.jsonl", [JSON.stringify({ timestamp: "2026-08-17T10:00:00.000Z", type: "event_msg", payload: {} })]);
    const usage = readCodexUsage();
    expect(usage.windows).toEqual([]);
    expect(usage.error).toContain("no rate-limit data");
  });

  test("no codex install at all is not an error state to crash on", () => {
    rmSync(home, { recursive: true, force: true });
    expect(readCodexUsage().windows).toEqual([]);
  });
});

describe("claudeOAuth", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-claude-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  test("reads the oauth block from the credentials file", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "tok", subscriptionType: "max" } }),
    );
    expect(claudeOAuth()).toEqual({ accessToken: "tok", subscriptionType: "max" });
  });

  test("corrupt credentials are treated as no credentials", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{nope");
    expect(claudeOAuth()).toBeNull();
  });

  test("an absent credentials file is 'not signed in', not an access problem", () => {
    // On linux there is no keychain to fall back to, so this is unambiguous.
    const read = readClaudeCredentials();
    expect(read.auth).toBeNull();
    if (process.platform !== "darwin") expect(read.unavailable).toBeUndefined();
  });
});

describe("formatting", () => {
  const now = new Date("2026-08-17T17:00:00.000Z");

  test("formatWindowMinutes names the windows codex meters", () => {
    expect(formatWindowMinutes(10080)).toBe("week");
    expect(formatWindowMinutes(300)).toBe("5h");
    expect(formatWindowMinutes(2880)).toBe("2d");
    expect(formatWindowMinutes(45)).toBe("45m");
  });

  test("formatResetIn counts down and goes quiet once the window has rolled", () => {
    expect(formatResetIn("2026-08-17T17:30:00.000Z", now)).toBe("30m");
    expect(formatResetIn("2026-08-17T21:21:00.000Z", now)).toBe("4h21m");
    expect(formatResetIn("2026-08-17T21:00:00.000Z", now)).toBe("4h");
    expect(formatResetIn("2026-08-20T17:00:00.000Z", now)).toBe("3d");
    expect(formatResetIn("2026-08-17T16:00:00.000Z", now)).toBeNull();
    expect(formatResetIn(undefined, now)).toBeNull();
  });

  test("usageBar fills proportionally", () => {
    expect(usageBar(0, 10)).toBe("░".repeat(10));
    expect(usageBar(100, 10)).toBe("█".repeat(10));
    expect(usageBar(50, 10)).toBe("█".repeat(5) + "░".repeat(5));
  });

  test("usageLevel escalates at the thresholds", () => {
    expect(usageLevel(74)).toBe("ok");
    expect(usageLevel(75)).toBe("warn");
    expect(usageLevel(90)).toBe("hot");
  });

  test("isStale only fires on an observation old enough to mislead", () => {
    expect(isStale({ provider: "codex", windows: [], observedAt: "2026-08-17T16:55:00.000Z" }, now)).toBe(false);
    expect(isStale({ provider: "codex", windows: [], observedAt: "2026-08-17T12:00:00.000Z" }, now)).toBe(true);
    // A live reading carries no observedAt and is never stale.
    expect(isStale({ provider: "claude", windows: [] }, now)).toBe(false);
  });

  const report: UsageReport = {
    generatedAt: now.toISOString(),
    providers: [
      {
        provider: "claude",
        plan: "max",
        windows: [
          { label: "5h", utilization: 11, resetsAt: "2026-08-17T20:19:00.000Z" },
          { label: "week", utilization: 75, resetsAt: "2026-08-17T17:59:00.000Z" },
        ],
      },
      {
        provider: "codex",
        plan: "prolite",
        observedAt: "2026-08-17T16:54:00.000Z",
        windows: [{ label: "week", utilization: 16 }],
      },
    ],
  };

  test("formatUsageReport renders a bar, a percentage and a countdown per window", () => {
    const lines = formatUsageReport(report, { color: false });
    expect(lines[0]).toBe("claude · max");
    expect(lines[1]).toBe("  5h    █░░░░░░░░░░░  11%  resets in 3h19m");
    expect(lines[2]).toBe("  week  █████████░░░  75%  resets in 59m");
    expect(lines[4]).toContain("codex · prolite");
    expect(lines[4]).toContain("6m ago");
  });

  test("an errored provider says why instead of showing bars", () => {
    const lines = formatUsageReport(
      { generatedAt: now.toISOString(), providers: [{ provider: "claude", windows: [], error: "not signed in" }] },
      { color: false },
    );
    expect(lines).toEqual(["claude", "  not signed in"]);
  });

  test("formatUsageBadge compresses to one glanceable line", () => {
    expect(formatUsageBadge(report, now)).toBe("claude 11%/5h 75%/wk · codex 16%/wk");
  });

  test("a stale reading is marked, and providers with nothing to say drop out", () => {
    const stale: UsageReport = {
      generatedAt: now.toISOString(),
      providers: [
        { provider: "claude", windows: [], error: "not signed in" },
        { provider: "codex", observedAt: "2026-08-17T09:00:00.000Z", windows: [{ label: "week", utilization: 16 }] },
      ],
    };
    expect(formatUsageBadge(stale, now)).toBe("codex 16%/wk?");
  });

  test("usagePollDelay backs off while readings keep coming back empty", () => {
    expect(usagePollDelay(0)).toBe(60_000);
    expect(usagePollDelay(1)).toBe(120_000);
    expect(usagePollDelay(3)).toBe(480_000);
    // Capped, so a hub left open for days doesn't drift into never asking.
    expect(usagePollDelay(50)).toBe(900_000);
  });

  test("no data at all yields no badge", () => {
    expect(formatUsageBadge({ generatedAt: now.toISOString(), providers: [] }, now)).toBeNull();
  });
});

describe("fetchClaudeUsage shared disk cache and 429 cooldown", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevAgentHome: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-claude-cache-"));
    prevHome = process.env.HOME;
    prevAgentHome = process.env.AGENTMGR_HOME;
    process.env.HOME = home;
    process.env.AGENTMGR_HOME = home;
    originalFetch = globalThis.fetch;
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-token",
          subscriptionType: "max",
          expiresAt: Date.now() + 3600_000,
        },
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentHome === undefined) delete process.env.AGENTMGR_HOME;
    else process.env.AGENTMGR_HOME = prevAgentHome;
  });

  test("caches 200 response on disk and falls back to cached windows on 429 cooldown", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 22, resets_at: "2026-11-02T22:00:00Z" },
          seven_day: { utilization: 64, resets_at: "2026-11-06T00:00:00Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;

    const first = await fetchClaudeUsage();
    expect(fetchCalls).toBe(1);
    expect(first.windows).toHaveLength(2);
    expect(readClaudeUsageCache().usage?.windows).toHaveLength(2);

    // Second call within TTL uses shared disk cache without hitting fetch
    const second = await fetchClaudeUsage();
    expect(fetchCalls).toBe(1);
    expect(second.windows[0]?.utilization).toBe(22);

    // Forced refresh receiving 429 records backoffUntil and still returns last known windows
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as any;

    const rateLimited = await fetchClaudeUsage({ bypassCache: true });
    expect(fetchCalls).toBe(2);
    expect(rateLimited.windows).toHaveLength(2);
    expect(rateLimited.observedAt).toBeTruthy();
    expect((readClaudeUsageCache().backoffUntil ?? 0) > Date.now()).toBe(true);

    // Subsequent call during cooldown does not hit fetch at all
    const duringCooldown = await fetchClaudeUsage({ bypassCache: true });
    expect(fetchCalls).toBe(2);
    expect(duringCooldown.windows).toHaveLength(2);
  });
});
