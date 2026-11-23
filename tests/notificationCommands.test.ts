import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { notificationSettingsCommand } from "../src/notificationCommands";
import { getNotificationSettings } from "../src/notificationPolicy";

let home: string;
let output: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-notification-cli-"));
  process.env.AGENTMGR_HOME = home;
  output = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore();
  delete process.env.AGENTMGR_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("CLI changes a kind and timer while preserving other settings", () => {
  notificationSettingsCommand({ positional: ["set", "idle", "off"], flags: {} });
  notificationSettingsCommand({ positional: ["set", "idleCooldownSeconds", "300"], flags: {} });
  expect(getNotificationSettings()).toMatchObject({ enabled: { idle: false, attention: true }, idleCooldownSeconds: 300 });
});

test("CLI rejects ambiguous or invalid settings without changing policy", () => {
  const initial = getNotificationSettings();
  for (const positional of [["set", "idle", "false"], ["set", "command", "value"],
    ["set", "idleMinSeconds", "NaN"], ["set", "idleMinSeconds", "-1"],
    ["set", "idleMinSeconds", "999999"], ["set", "idle"], ["settings", "extra"]]) {
    expect(() => notificationSettingsCommand({ positional, flags: {} })).toThrow();
    expect(getNotificationSettings()).toEqual(initial);
  }
});

test("legacy --json still lists history and settings --json shows policy", () => {
  notificationSettingsCommand({ positional: [], flags: { json: true } });
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual([]);
  notificationSettingsCommand({ positional: ["settings"], flags: { json: true } });
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ idleCooldownSeconds: 600 });
});
