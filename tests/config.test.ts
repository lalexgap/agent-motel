import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNotificationSettings, loadConfig, setAgentMuted, shouldNotifyIdle, subagentPermissionWait, updateNotificationSettings, type Config } from "../src/config";
import { configFile } from "../src/paths";
import { readSnapshot, removeSnapshot, writeSnapshot } from "../src/snapshots";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("loadConfig", () => {
  test("defaults when no file exists", () => {
    expect(loadConfig()).toEqual({ defaultProvider: "codex", conciergeProvider: "codex", notifyOnIdle: true, idleNotifyMinSeconds: 30, notifications: { enabled: { attention: true, idle: true, share: true, pr: true, decision: true }, idleMinSeconds: 120, idleCooldownSeconds: 600, idleCoalesceSeconds: 60, mutedAgents: [] }, remoteControl: true, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, skipPermissions: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30, tunnelPort: 2222, showUsage: true, gcAgentDays: 7, gcTrashDays: 30, gcMergedDays: 3, gcRemovedDays: 7, gcOrphanDays: 3, gcStaleDays: 30, gcIgnoredDays: 7, gcFileDays: 30, gcAuto: true, gcAutoHour: 4, gcAutoMaxMinutes: 15, gcAutoMaxLoad: 1, gcAutoMaxPressure: 20, permissionWaitSeconds: 120, subagentPermissionWaitSeconds: 15, pretrustClaudeDirs: true, plans: true, decisions: true, decisionsStopMode: "block", prPollSeconds: 120, selfModelSwitchMaxTurns: 2 });
  });

  test("file values override defaults, missing keys keep defaults", () => {
    writeFileSync(configFile(), JSON.stringify({ idleNotifyMinSeconds: 120, remoteControl: false }));
    expect(loadConfig()).toEqual({ defaultProvider: "codex", conciergeProvider: "codex", notifyOnIdle: true, idleNotifyMinSeconds: 120, notifications: { enabled: { attention: true, idle: true, share: true, pr: true, decision: true }, idleMinSeconds: 120, idleCooldownSeconds: 600, idleCoalesceSeconds: 60, mutedAgents: [] }, remoteControl: false, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, skipPermissions: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30, tunnelPort: 2222, showUsage: true, gcAgentDays: 7, gcTrashDays: 30, gcMergedDays: 3, gcRemovedDays: 7, gcOrphanDays: 3, gcStaleDays: 30, gcIgnoredDays: 7, gcFileDays: 30, gcAuto: true, gcAutoHour: 4, gcAutoMaxMinutes: 15, gcAutoMaxLoad: 1, gcAutoMaxPressure: 20, permissionWaitSeconds: 120, subagentPermissionWaitSeconds: 15, pretrustClaudeDirs: true, plans: true, decisions: true, decisionsStopMode: "block", prPollSeconds: 120, selfModelSwitchMaxTurns: 2 });
  });

  test("corrupt file falls back to defaults", () => {
    writeFileSync(configFile(), "{nope");
    expect(loadConfig().notifyOnIdle).toBe(true);
  });

  test("defaultProvider defaults to codex and honors an override", () => {
    expect(loadConfig().defaultProvider).toBe("codex");
    writeFileSync(configFile(), JSON.stringify({ defaultProvider: "claude" }));
    expect(loadConfig().defaultProvider).toBe("claude");
  });
});

describe("notification settings", () => {
  test("normalizes legacy fields independently when the new section is partial", () => {
    writeFileSync(configFile(), JSON.stringify({ notifyOnIdle: false, idleNotifyMinSeconds: 45, notifications: { mutedAgents: ["api"] } }));
    expect(getNotificationSettings()).toMatchObject({ enabled: { idle: false }, idleMinSeconds: 45, mutedAgents: ["api"] });
  });

  test("strictly patches the section while preserving unknown config fields", () => {
    writeFileSync(configFile(), JSON.stringify({ futureOption: { keep: true }, notifications: { enabled: { idle: false } } }));
    expect(updateNotificationSettings({ enabled: {}, idleCooldownSeconds: 90 }).idleCooldownSeconds).toBe(90);
    expect(setAgentMuted("api", true).mutedAgents).toEqual(["api"]);
    const stored = JSON.parse(readFileSync(configFile(), "utf8"));
    expect(stored.futureOption).toEqual({ keep: true });
    expect(() => updateNotificationSettings({ nope: true })).toThrow("unknown notification setting");
    expect(() => updateNotificationSettings({ idleMinSeconds: -1 })).toThrow("must be an integer");
    expect(() => updateNotificationSettings({ enabled: { idle: "yes" } })).toThrow("must be boolean");
  });

  test("keeps the reportTo threshold independent from idle notification settings", () => {
    expect(loadConfig().idleNotifyMinSeconds).toBe(30);
    updateNotificationSettings({ idleMinSeconds: 0 });
    expect(loadConfig().idleNotifyMinSeconds).toBe(30);
    updateNotificationSettings({ idleMinSeconds: 86_400 });
    expect(loadConfig().idleNotifyMinSeconds).toBe(30);
    writeFileSync(configFile(), JSON.stringify({ idleNotifyMinSeconds: 45, notifications: { idleMinSeconds: 0 } }));
    expect(loadConfig().idleNotifyMinSeconds).toBe(45);
  });

  test("keeps config private across settings and mute writes", () => {
    writeFileSync(configFile(), JSON.stringify({ notifyCommand: "inert" }), { mode: 0o600 });
    chmodSync(configFile(), 0o600);
    updateNotificationSettings({ idleMinSeconds: 15 });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    setAgentMuted("api", true);
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
  });

  test("refuses to overwrite malformed existing config", () => {
    writeFileSync(configFile(), "{broken");
    expect(() => updateNotificationSettings({ enabled: { idle: false } })).toThrow();
  });
});

describe("shouldNotifyIdle", () => {
  const config: Config = { defaultProvider: "codex", conciergeProvider: "codex", notifyOnIdle: true, idleNotifyMinSeconds: 30, notifications: { enabled: { attention: true, idle: true, share: true, pr: true, decision: true }, idleMinSeconds: 30, idleCooldownSeconds: 600, idleCoalesceSeconds: 60, mutedAgents: [] }, remoteControl: true, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, skipPermissions: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30, tunnelPort: 2222, showUsage: true, gcAgentDays: 7, gcTrashDays: 30, gcMergedDays: 3, gcRemovedDays: 7, gcOrphanDays: 3, gcStaleDays: 30, gcIgnoredDays: 7, gcFileDays: 30, gcAuto: true, gcAutoHour: 4, gcAutoMaxMinutes: 15, gcAutoMaxLoad: 1, gcAutoMaxPressure: 20, permissionWaitSeconds: 120, subagentPermissionWaitSeconds: 15, pretrustClaudeDirs: true, plans: true, decisions: true, decisionsStopMode: "block", prPollSeconds: 120, selfModelSwitchMaxTurns: 2 };
  const base = { config, workedSeconds: 60, queueDepth: 0, attached: false };

  test("notifies after a real unattended stint", () => {
    expect(shouldNotifyIdle(base)).toBe(true);
  });

  test("suppressed while attached", () => {
    expect(shouldNotifyIdle({ ...base, attached: true })).toBe(false);
  });

  test("suppressed when a queued message is about to deliver", () => {
    expect(shouldNotifyIdle({ ...base, queueDepth: 2 })).toBe(false);
  });

  test("suppressed for short stints and when disabled", () => {
    expect(shouldNotifyIdle({ ...base, workedSeconds: 5 })).toBe(false);
    expect(shouldNotifyIdle({ ...base, config: { ...config, notifyOnIdle: false } })).toBe(false);
  });
});

describe("snapshots", () => {
  test("round-trip, truncation to last 40 lines, and removal", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    writeSnapshot("alpha", lines);

    const back = readSnapshot("alpha");
    expect(back).toHaveLength(40);
    expect(back![0]).toBe("line 10");
    expect(back![39]).toBe("line 49");

    removeSnapshot("alpha");
    expect(readSnapshot("alpha")).toBeNull();
  });
});

describe("subagentPermissionWait", () => {
  const wait = (permissionWaitSeconds: number, subagentPermissionWaitSeconds: number) =>
    subagentPermissionWait({ permissionWaitSeconds, subagentPermissionWaitSeconds });

  test("is the subagent wait, never longer than the relay's own", () => {
    expect(wait(120, 15)).toBe(15);
    expect(wait(10, 15)).toBe(10);
    expect(wait(120, 300)).toBe(120);
  });

  test("either wait at zero turns the hold off", () => {
    expect(wait(0, 15)).toBe(0);
    expect(wait(120, 0)).toBe(0);
    expect(wait(120, -5)).toBe(0);
  });
});
