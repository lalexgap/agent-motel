import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateNotificationSettings, type NotificationSettings } from "../src/config";
import { ensureDirs } from "../src/paths";
import {
  flushIdleNotifications,
  focusedNotificationAgents,
  idleSuppressionReason,
  queueIdleNotification,
  recordNotificationActivity,
  recordNotificationPresence,
} from "../src/notificationPolicy";
import { writeAgent, type AgentState } from "../src/state";

let home: string;

const settings: NotificationSettings = {
  enabled: { attention: true, idle: true, share: true, pr: true, decision: true },
  idleMinSeconds: 120,
  idleCooldownSeconds: 600,
  idleCoalesceSeconds: 60,
  mutedAgents: [],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-notification-policy-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
  updateNotificationSettings({ idleMinSeconds: 0, idleCooldownSeconds: 0, idleCoalesceSeconds: 60 });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function agent(name: string, at: number, extra: Partial<AgentState> = {}): AgentState {
  const state: AgentState = {
    name,
    status: "idle",
    statusChangedAt: new Date(at).toISOString(),
    dir: home,
    tmuxSession: `am-policy-test-${name}-missing`,
    createdAt: new Date(at - 10_000).toISOString(),
    updatedAt: new Date(at).toISOString(),
    ...extra,
  };
  writeAgent(state);
  return state;
}

describe("idle timestamp policy", () => {
  const base = { agent: "api", workedSeconds: 180, settings, now: 1_000_000 };

  test("suppresses invalid and short work, mute/focus, cooldown, and notable activity during the stint", () => {
    expect(idleSuppressionReason({ ...base, workedSeconds: Number.NaN })).toBe("short-stint");
    expect(idleSuppressionReason({ ...base, workedSeconds: 119 })).toBe("short-stint");
    expect(idleSuppressionReason({ ...base, settings: { ...settings, mutedAgents: ["api"] } })).toBe("muted");
    expect(idleSuppressionReason({ ...base, focused: true })).toBe("focused");
    expect(idleSuppressionReason({ ...base, lastIdleAt: base.now - 599_000 })).toBe("cooldown");
    expect(idleSuppressionReason({ ...base, workStartedAt: base.now - 180_000, recentActivityAt: base.now - 170_000 })).toBe("recent-activity");
    expect(idleSuppressionReason({ ...base, agent: "concierge" })).toBe("concierge");
  });

  test("flush-only state rejects a resumed agent, running subagents, and stale work", () => {
    expect(idleSuppressionReason({ ...base, flushing: true, status: "working" })).toBe("working-again");
    expect(idleSuppressionReason({ ...base, flushing: true, status: "idle", runningSubagents: 1 })).toBe("running-subagents");
    expect(idleSuppressionReason({ ...base, flushing: true, status: "idle", dueAt: base.now - 600_001 })).toBe("stale");
  });
});

describe("durable idle queue", () => {
  test("agents stopping 30 seconds apart share the first batch deadline", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const first = agent("first", start);
    const second = agent("second", start + 30_000);
    expect(queueIdleNotification({ agent: first, workedSeconds: 180 }, start)).toEqual({ queued: true });
    expect(queueIdleNotification({ agent: second, workedSeconds: 180 }, start + 30_000)).toEqual({ queued: true });
    expect(flushIdleNotifications(start + 59_999)).toEqual([]);
    expect(flushIdleNotifications(start + 60_000)).toEqual([{
      title: "am: agents idle",
      message: "2 agents finished — idle: first, second",
      meta: { kind: "idle" },
    }]);
  });

  test("a decision arriving while pending cancels the idle at the boundary", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const state = agent("api", start);
    expect(queueIdleNotification({ agent: state, workedSeconds: 180 }, start).queued).toBe(true);
    recordNotificationActivity("api", "decision", start + 60_000);
    expect(flushIdleNotifications(start + 60_000)).toEqual([]);
  });

  test("a newer idle transition cannot emit an older stint", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const state = agent("api", start);
    queueIdleNotification({ agent: state, workedSeconds: 180 }, start);
    agent("api", start + 30_000);
    expect(flushIdleNotifications(start + 60_000)).toEqual([]);
  });
});

describe("notification presence", () => {
  test("strictly validates input and expires focused clients after 45 seconds", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(recordNotificationPresence({ clientId: "mac:main.1", agent: "api", focused: true }, now)).toMatchObject({ agent: "api", focused: true });
    expect(focusedNotificationAgents(now + 44_999)).toEqual(new Set(["api"]));
    expect(focusedNotificationAgents(now + 45_001)).toEqual(new Set());
    expect(() => recordNotificationPresence({ clientId: "bad space", focused: true }, now)).toThrow("clientId");
    expect(() => recordNotificationPresence({ clientId: "ok", agent: "remote:api", focused: true }, now)).toThrow("local agent");
    expect(() => recordNotificationPresence({ clientId: "ok", focused: 1 }, now)).toThrow("focused");
    expect(() => recordNotificationPresence({ clientId: "ok", focused: true, extra: true }, now)).toThrow("unknown");
  });
});
