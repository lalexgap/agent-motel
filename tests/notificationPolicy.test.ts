import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateNotificationSettings, type NotificationSettings } from "../src/config";
import { daemonSocket, ensureDirs } from "../src/paths";
import {
  flushIdleNotifications,
  focusedNotificationAgents,
  idleSuppressionReason,
  queueIdleNotification,
  recordNotificationActivity,
  recordNotificationPresence,
  nextIdleNotificationWake,
  pendingIdleCount,
} from "../src/notificationPolicy";
import { idleNotificationFallbackCommand, runIdleNotificationFallback } from "../src/idleNotificationFallback";
import { tryAcquireFileLock } from "../src/filelock";
import { readNotifications } from "../src/notifications";
import { notify } from "../src/notify";
import { removeAgent, writeAgent, type AgentState } from "../src/state";
import { recordSubagentStart, recordSubagentStop } from "../src/subagents";
import { queueAppend } from "../src/queue";

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
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true" }));
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

  test("suppresses invalid and short work, mute/focus, cooldown, and activity near stopping", () => {
    expect(idleSuppressionReason({ ...base, workedSeconds: Number.NaN })).toBe("short-stint");
    expect(idleSuppressionReason({ ...base, workedSeconds: 119 })).toBe("short-stint");
    expect(idleSuppressionReason({ ...base, settings: { ...settings, mutedAgents: ["api"] } })).toBe("muted");
    expect(idleSuppressionReason({ ...base, focused: true })).toBe("focused");
    expect(idleSuppressionReason({ ...base, attached: true })).toBe("attached");
    expect(idleSuppressionReason({ ...base, lastIdleAt: base.now - 599_000 })).toBe("cooldown");
    expect(idleSuppressionReason({ ...base, recentActivityAt: base.now - 60_000 })).toBe("recent-activity");
    expect(idleSuppressionReason({ ...base, recentActivityAt: base.now - 60_001 })).toBeNull();
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
    expect(queueIdleNotification({ agent: first, workedSeconds: 180 }, start)).toMatchObject({ queued: true, dueAt: new Date(start + 60_000).toISOString() });
    expect(queueIdleNotification({ agent: second, workedSeconds: 180 }, start + 30_000)).toMatchObject({ queued: true, dueAt: new Date(start + 60_000).toISOString() });
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

  test("activity hours earlier does not suppress a completed stint", () => {
    const start = Date.parse("2026-01-01T04:00:00.000Z");
    recordNotificationActivity("api", "pr", start - 3 * 60 * 60_000);
    const state = agent("api", start);
    expect(queueIdleNotification({ agent: state, workedSeconds: 4 * 60 * 60 }, start).queued).toBe(true);
    expect(flushIdleNotifications(start + 60_000)).toHaveLength(1);
  });

  test("activity just before stopping suppresses at the coalesce boundary", () => {
    const start = Date.parse("2026-01-01T04:00:00.000Z");
    recordNotificationActivity("api", "share", start - 60_000);
    const state = agent("api", start);
    expect(queueIdleNotification({ agent: state, workedSeconds: 4 * 60 * 60 }, start)).toEqual({ queued: false, reason: "recent-activity" });
  });

  test("only enabled notable notifications suppress idle", () => {
    const start = Date.now();
    const state = agent("api", start);
    updateNotificationSettings({ enabled: { pr: false } });
    notify("PR", "disabled", { agent: "api", kind: "pr" });
    expect(queueIdleNotification({ agent: state, workedSeconds: 180 }, start).queued).toBe(true);
    flushIdleNotifications(start + 60_000);

    const secondAt = Date.now();
    const second = agent("api", secondAt);
    updateNotificationSettings({ enabled: { pr: true } });
    notify("PR", "enabled", { agent: "api", kind: "pr" });
    expect(queueIdleNotification({ agent: second, workedSeconds: 180 }, secondAt))
      .toEqual({ queued: false, reason: "recent-activity" });
  });

  test("a newer idle transition cannot emit an older stint", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const state = agent("api", start);
    queueIdleNotification({ agent: state, workedSeconds: 180 }, start);
    agent("api", start + 30_000);
    expect(flushIdleNotifications(start + 60_000)).toEqual([]);
  });

  test("one-shot fallback waits for the queue deadline and delivers when the daemon is absent", async () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const state = agent("api", start);
    const pending = queueIdleNotification({ agent: state, workedSeconds: 180 }, start);
    const delivered: unknown[] = [];
    let waited = 0;
    let now = start;
    await runIdleNotificationFallback(pending.dueAt!, {
      now: () => now,
      sleep: async (milliseconds) => { waited += milliseconds; now += milliseconds; },
      flush: () => flushIdleNotifications(now),
      deliver: (notification) => delivered.push(notification),
      nextWake: () => nextIdleNotificationWake(now),
    });
    expect(waited).toBe(60_000);
    expect(delivered).toHaveLength(1);
  });

  test("one-shot fallback does not redeliver a queue already flushed by a recovered daemon", async () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const state = agent("api", start);
    const pending = queueIdleNotification({ agent: state, workedSeconds: 180 }, start);
    const daemonDelivery = flushIdleNotifications(start + 60_000);
    const delivered: unknown[] = [];
    await runIdleNotificationFallback(pending.dueAt!, {
      now: () => start + 60_000,
      sleep: async () => {},
      flush: () => flushIdleNotifications(start + 60_000),
      deliver: (notification) => delivered.push(notification),
      nextWake: () => undefined,
    });
    expect(daemonDelivery).toHaveLength(1);
    expect(delivered).toEqual([]);
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

describe("aggregate completion", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = (at: number) => new Date(at).toISOString();
  function deferred(workedSeconds = 180, name = "api") {
    const parent = agent(name, start);
    recordSubagentStart(name, { id: "child", at: iso(start - 1000) });
    const pending = queueIdleNotification({ agent: parent, workedSeconds, runningSubagents: 1 }, start);
    expect(pending.queued).toBe(true);
    return { parent, pending };
  }
  function finish(at: number, name = "api") {
    recordSubagentStop(name, { id: "child", at: iso(at) });
  }

  test("retains work beyond the old stale deadline and batches once after the last child", () => {
    deferred();
    recordSubagentStart("api", { id: "second", at: iso(start) });
    expect(flushIdleNotifications(start + 60_000)).toEqual([]);
    expect(flushIdleNotifications(start + 700_000)).toEqual([]);
    expect(pendingIdleCount()).toBe(1);
    finish(start + 710_000);
    expect(flushIdleNotifications(start + 710_000)).toEqual([]);
    recordSubagentStop("api", { id: "second", at: iso(start + 720_000) });
    expect(flushIdleNotifications(start + 720_000)).toEqual([]);
    expect(nextIdleNotificationWake(start + 720_000)).toBe(start + 780_000);
    const other = agent("other", start + 730_000);
    expect(queueIdleNotification({ agent: other, workedSeconds: 180 }, start + 730_000).dueAt).toBe(iso(start + 780_000));
    expect(flushIdleNotifications(start + 779_999)).toEqual([]);
    expect(flushIdleNotifications(start + 780_000)).toMatchObject([{ message: "2 agents finished — idle: api, other" }]);
    expect(flushIdleNotifications(start + 800_000)).toEqual([]);
  });

  test("short parent plus long child crosses minimum; a quick child does not", () => {
    updateNotificationSettings({ idleMinSeconds: 120 });
    deferred(5, "long");
    deferred(5, "short");
    finish(start + 10_000, "short");
    finish(start + 180_000, "long");
    expect(flushIdleNotifications(start + 180_000)).toEqual([]);
    expect(pendingIdleCount()).toBe(1);
    expect(flushIdleNotifications(start + 240_000)).toMatchObject([{ meta: { agent: "long" }, message: "finished — idle after 3m5s" }]);
  });

  test("late observation delivers completion only within its original stale window", () => {
    deferred();
    finish(start + 720_000);
    expect(flushIdleNotifications(start + 840_000)).toMatchObject([{ meta: { agent: "api" } }]);
    expect(pendingIdleCount()).toBe(0);
    expect(flushIdleNotifications(start + 900_000)).toEqual([]);
  });

  for (const newerBatch of [false, true]) {
    test(`late observation discards stale completion despite a newer batch: ${newerBatch}`, () => {
      deferred();
      finish(start + 720_000);
      const observedAt = start + 2_400_000;
      if (newerBatch) {
        const other = agent("other", observedAt);
        queueIdleNotification({ agent: other, workedSeconds: 180 }, observedAt);
      }
      expect(flushIdleNotifications(observedAt)).toEqual([]);
      expect(pendingIdleCount()).toBe(newerBatch ? 1 : 0);
      const deliveries = flushIdleNotifications(observedAt + 60_000);
      expect(deliveries).toEqual(newerBatch ? [{
        title: "am: other", message: "finished — idle after 3m0s", meta: { agent: "other", kind: "idle" },
      }] : []);
    });
  }

  test("a working parent cannot shorten another agent's batch window", () => {
    deferred();
    const stoppedAt = start + 1000;
    const other = agent("other", stoppedAt);
    expect(queueIdleNotification({ agent: other, workedSeconds: 180 }, stoppedAt).dueAt).toBe(iso(stoppedAt + 60_000));
    expect(flushIdleNotifications(start + 5000)).toEqual([]);
    finish(start + 30_000);
    expect(flushIdleNotifications(start + 30_000)).toEqual([]);
    expect(flushIdleNotifications(stoppedAt + 59_999)).toEqual([]);
    expect(flushIdleNotifications(stoppedAt + 60_000)).toMatchObject([{ message: "2 agents finished — idle: api, other" }]);
  });

  test("children still running after 24 hours expire without a notification", () => {
    deferred();
    expect(flushIdleNotifications(start + 86_400_000)).toEqual([]);
    expect(pendingIdleCount()).toBe(0);
  });

  for (const change of ["missing", "exited", "resumed", "new-session", "recreated", "queued", "focused", "muted", "concierge", "disabled", "minimum"] as const) {
    test(`rechecks ${change} before sending deferred completion`, () => {
      const { parent } = deferred();
      finish(start + 700_000);
      flushIdleNotifications(start + 700_000);
      const sendAt = start + 760_000;
      if (change === "missing") removeAgent("api");
      if (change === "exited") writeAgent({ ...parent, status: "exited" });
      if (change === "resumed") writeAgent({ ...parent, statusChangedAt: iso(sendAt - 1000) });
      if (change === "new-session") writeAgent({ ...parent, sessionId: "new" });
      if (change === "recreated") writeAgent({ ...parent, createdAt: iso(sendAt) });
      if (change === "queued") queueAppend("api", "next task");
      if (change === "focused") recordNotificationPresence({ clientId: "test", agent: "api", focused: true }, sendAt);
      if (change === "muted") updateNotificationSettings({ mutedAgents: ["api"] });
      if (change === "concierge") writeAgent({ ...parent, role: "concierge" });
      if (change === "disabled") updateNotificationSettings({ enabled: { idle: false } });
      if (change === "minimum") updateNotificationSettings({ idleMinSeconds: 2000 });
      expect(flushIdleNotifications(sendAt)).toEqual([]);
      expect(pendingIdleCount()).toBe(0);
    });
  }

  test("resuming while children run cancels the old candidate", () => {
    const { parent } = deferred();
    writeAgent({ ...parent, status: "working" });
    expect(flushIdleNotifications(start + 5000)).toEqual([]);
    expect(pendingIdleCount()).toBe(0);
  });

  test("defers focus, attachment, recent activity and cooldown until completion", () => {
    const parent = agent("api", start);
    queueIdleNotification({ agent: parent, workedSeconds: 180 }, start);
    expect(flushIdleNotifications(start + 60_000)).toHaveLength(1);
    updateNotificationSettings({ idleMinSeconds: 120, idleCooldownSeconds: 600 });
    const stoppedAt = start + 70_000;
    const next = agent("api", stoppedAt);
    recordSubagentStart("api", { id: "child", at: iso(stoppedAt) });
    recordNotificationActivity("api", "pr", stoppedAt - 1);
    recordNotificationPresence({ clientId: "test", agent: "api", focused: true }, stoppedAt);
    expect(queueIdleNotification({ agent: next, workedSeconds: 5, attached: true, runningSubagents: 1 }, stoppedAt).queued).toBe(true);
    finish(start + 800_000);
    expect(flushIdleNotifications(start + 800_000)).toEqual([]);
    expect(flushIdleNotifications(start + 860_000)).toHaveLength(1);
  });

  for (const tracked of [false, true]) {
    test(`Stop hook waiting indicator retains only tracked background children: ${tracked}`, async () => {
      const at = Date.now();
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "tmux"), '#!/bin/sh\ncase "$1" in\n capture-pane) printf "────────\\n1 background task\\n" ;;\n list-clients) printf "watched\\n" ;;\n *) exit 0 ;;\nesac\n', { mode: 0o755 });
      const transcript = join(home, "parent.jsonl");
      writeFileSync(transcript, "");
      const children = join(home, "parent", "subagents");
      mkdirSync(children, { recursive: true });
      writeFileSync(join(children, "agent-child.meta.json"), JSON.stringify({ requestShape: "background" }));
      agent("api", at, { provider: "claude", status: "working", workingSince: iso(at - 5000), transcriptPath: transcript });
      if (tracked) recordSubagentStart("api", { id: "child", at: iso(at - 1000) });
      writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true", decisions: false, plans: false,
        notifications: { idleMinSeconds: 120, idleCooldownSeconds: 0, idleCoalesceSeconds: 60 } }));
      const server = Bun.serve({ unix: daemonSocket(), fetch: () => Response.json({ ok: true }) });
      try {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "hook", "stop"], {
          env: { ...process.env, AGENTMGR_AGENT: "api", AGENTMGR_SYSTEMD: "0", AGENTMGR_PEER_INBOX: "", PATH: `${bin}:${process.env.PATH}` },
          stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        child.stdin.write("{}");
        child.stdin.end();
        expect(await child.exited).toBe(0);
        expect(pendingIdleCount()).toBe(tracked ? 1 : 0);
        if (tracked) {
          finish(at + 720_000);
          expect(flushIdleNotifications(at + 720_000)).toEqual([]);
          expect(flushIdleNotifications(at + 780_000)).toHaveLength(1);
        }
      } finally { server.stop(true); }
    });
  }

  for (const recoveredDaemon of [false, true]) {
    test(`fallback retains and rearms child work, recovered daemon=${recoveredDaemon}`, async () => {
      const { pending } = deferred(5);
      updateNotificationSettings({ idleMinSeconds: 120 });
      let now = start;
      let finished = false;
      const delivered: unknown[] = [];
      await runIdleNotificationFallback(pending.dueAt!, {
        now: () => now,
        sleep: async (milliseconds) => {
          expect(milliseconds).toBeGreaterThan(0);
          expect(milliseconds).toBeLessThanOrEqual(5000);
          now += milliseconds;
          if (!finished && now >= start + 720_000) { finish(now); finished = true; }
          if (recoveredDaemon) delivered.push(...flushIdleNotifications(now));
        },
        flush: () => flushIdleNotifications(now),
        deliver: (notification) => delivered.push(notification),
        nextWake: () => nextIdleNotificationWake(now),
      });
      expect(now).toBe(start + 780_000);
      expect(delivered).toHaveLength(1);
      expect(pendingIdleCount()).toBe(0);
    });
  }

  test("zero batching retains the independent 60-second notable activity window", () => {
    updateNotificationSettings({ idleCoalesceSeconds: 0 });
    const recent = agent("recent", start);
    const old = agent("old", start);
    recordNotificationActivity("recent", "pr", start - 1);
    recordNotificationActivity("old", "pr", start - 60_001);
    expect(queueIdleNotification({ agent: recent, workedSeconds: 180 }, start)).toMatchObject({ queued: false, reason: "recent-activity" });
    expect(queueIdleNotification({ agent: old, workedSeconds: 180 }, start).queued).toBe(true);
    expect(flushIdleNotifications(start)).toMatchObject([{ meta: { agent: "old" } }]);
  });

  test("activity during the new batch suppresses even a delayed flush", () => {
    deferred();
    finish(start + 720_000);
    flushIdleNotifications(start + 720_000);
    recordNotificationActivity("api", "decision", start + 730_000);
    expect(flushIdleNotifications(start + 900_000)).toEqual([]);
    expect(pendingIdleCount()).toBe(0);
  });

  test("an existing fallback worker prevents another polling loop", async () => {
    const { pending } = deferred();
    const release = tryAcquireFileLock(join(home, "idle-notification-fallback.lock"))!;
    try {
      await idleNotificationFallbackCommand(pending.dueAt!);
      expect(pendingIdleCount()).toBe(1);
    } finally { release(); }
  });

  test("concurrent fallback processes claim a completed candidate only once", async () => {
    updateNotificationSettings({ idleCoalesceSeconds: 0 });
    const now = Date.now();
    const state = agent("api", now);
    const pending = queueIdleNotification({ agent: state, workedSeconds: 180 }, now);
    const children = [0, 1].map(() => Bun.spawn([
      process.execPath, join(import.meta.dir, "../src/index.ts"), "__flush-idle", pending.dueAt!,
    ], { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    expect(readNotifications().filter((entry) => entry.kind === "idle")).toHaveLength(1);
    expect(pendingIdleCount()).toBe(0);
  });
});
