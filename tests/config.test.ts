import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, shouldNotifyIdle, type Config } from "../src/config";
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
    expect(loadConfig()).toEqual({ notifyOnIdle: true, idleNotifyMinSeconds: 30, remoteControl: true, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30 });
  });

  test("file values override defaults, missing keys keep defaults", () => {
    writeFileSync(configFile(), JSON.stringify({ idleNotifyMinSeconds: 120, remoteControl: false }));
    expect(loadConfig()).toEqual({ notifyOnIdle: true, idleNotifyMinSeconds: 120, remoteControl: false, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30 });
  });

  test("corrupt file falls back to defaults", () => {
    writeFileSync(configFile(), "{nope");
    expect(loadConfig().notifyOnIdle).toBe(true);
  });
});

describe("shouldNotifyIdle", () => {
  const config: Config = { notifyOnIdle: true, idleNotifyMinSeconds: 30, remoteControl: true, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30 };
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
