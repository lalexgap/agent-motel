import { describe, expect, test } from "bun:test";
import { isForwardable, stripHostArgs } from "../src/remote";
import { chooseOpener } from "../src/commands/click";
import { buildNotifyCommand } from "../src/notify";
import type { Config } from "../src/config";

describe("stripHostArgs", () => {
  test("removes --host/-H with value and --local/-L", () => {
    expect(stripHostArgs(["-H", "box", "ls", "--json"])).toEqual(["ls", "--json"]);
    expect(stripHostArgs(["new", "x", "--host", "box", "-m", "hi"])).toEqual(["new", "x", "-m", "hi"]);
    expect(stripHostArgs(["-L", "ls"])).toEqual(["ls"]);
    expect(stripHostArgs(["ls"])).toEqual(["ls"]);
  });
});

describe("isForwardable", () => {
  test("user commands forward, internals never do", () => {
    expect(isForwardable(undefined)).toBe(true); // bare am → remote hub
    expect(isForwardable("ls")).toBe(true);
    expect(isForwardable("new")).toBe(true);
    expect(isForwardable("hook")).toBe(false);
    expect(isForwardable("__deliver")).toBe(false);
    expect(isForwardable("__click")).toBe(false);
    expect(isForwardable("__daemon")).toBe(false);
  });
});

describe("chooseOpener", () => {
  test("open on macOS, xdg-open with a display, null headless", () => {
    expect(chooseOpener({ platform: "darwin", has: () => false, display: false })).toBe("open");
    expect(chooseOpener({ platform: "linux", has: () => true, display: true })).toBe("xdg-open");
    expect(chooseOpener({ platform: "linux", has: () => true, display: false })).toBeNull();
    expect(chooseOpener({ platform: "linux", has: () => false, display: true })).toBeNull();
  });
});

describe("buildNotifyCommand", () => {
  const base: Config = { notifyOnIdle: true, idleNotifyMinSeconds: 30, remoteControl: true, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30 };

  test("notifyCommand wins on any platform", () => {
    const config = { ...base, notifyCommand: "curl -d \"$AM_MESSAGE\" ntfy.sh/x" };
    expect(buildNotifyCommand("t", "m", config, { platform: "linux", has: () => false })).toEqual([
      "sh", "-c", 'curl -d "$AM_MESSAGE" ntfy.sh/x',
    ]);
    expect(buildNotifyCommand("t", "m", config, { platform: "darwin", has: () => true })![0]).toBe("sh");
  });

  test("macOS: terminal-notifier with sender, else osascript", () => {
    const withSender = { ...base, notifySender: "com.mitchellh.ghostty" };
    expect(buildNotifyCommand("t", "m", withSender, { platform: "darwin", has: () => true })![0]).toBe("terminal-notifier");
    expect(buildNotifyCommand("t", "m", withSender, { platform: "darwin", has: () => false })![0]).toBe("osascript");
    expect(buildNotifyCommand("t", "m", base, { platform: "darwin", has: () => true })![0]).toBe("osascript");
  });

  test("linux: notify-send when present, else silent null", () => {
    expect(buildNotifyCommand("t", "m", base, { platform: "linux", has: () => true })).toEqual([
      "notify-send", "t", "m",
    ]);
    expect(buildNotifyCommand("t", "m", base, { platform: "linux", has: () => false })).toBeNull();
  });
});
