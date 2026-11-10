import { describe, expect, test } from "bun:test";
import { osc9, parseTmuxClients, pickItermClient, writeOsc9 } from "../src/notify";

describe("iTerm2 notifications", () => {
  test("parses tmux list-clients output", () => {
    expect(parseTmuxClients("/dev/ttys000\tiTerm2 3.7.7\t1794242410\t1\t0\n/dev/ttys004\t\t5\t0\t1\n\n")).toEqual([
      { tty: "/dev/ttys000", termtype: "iTerm2 3.7.7", activity: 1794242410, utf8: true, controlMode: false },
      { tty: "/dev/ttys004", termtype: "", activity: 5, utf8: false, controlMode: true },
    ]);
    expect(parseTmuxClients("no server running on /tmp/tmux-501/default\n")).toEqual([]);
  });

  test("picks the most recently active iTerm2 client only", () => {
    const clients = [
      { tty: "/dev/ttys001", termtype: "iTerm2 3.7.7", activity: 10, utf8: true, controlMode: false },
      { tty: "/dev/ttys002", termtype: "ghostty 1.2", activity: 99, utf8: true, controlMode: false },
      { tty: "/dev/ttys003", termtype: "iTerm2 3.7.7", activity: 20, utf8: true, controlMode: false },
    ];
    expect(pickItermClient(clients)?.tty).toBe("/dev/ttys003");
    expect(pickItermClient([clients[1]!])).toBeNull();
    expect(pickItermClient([])).toBeNull();
  });

  test("skips non-UTF-8 and control-mode iTerm2 clients", () => {
    const clients = [
      { tty: "/dev/ttys001", termtype: "iTerm2 3.7.7", activity: 10, utf8: true, controlMode: false },
      { tty: "/dev/ttys002", termtype: "iTerm2 3.7.7", activity: 30, utf8: false, controlMode: false },
      { tty: "/dev/ttys003", termtype: "iTerm2 3.7.7", activity: 20, utf8: true, controlMode: true },
    ];
    expect(pickItermClient(clients)?.tty).toBe("/dev/ttys001");
    expect(pickItermClient(clients.slice(1))).toBeNull();
  });

  test("reports a short write as failure", () => {
    let written: Buffer | undefined;
    expect(writeOsc9((data) => (written = data).length, "am: x", "é")).toBe(true);
    expect(written?.toString()).toBe(osc9("am: x", "é"));
    expect(writeOsc9((data) => data.length - 1, "am: x", "é")).toBe(false);
    expect(writeOsc9(() => 0, "am: x", "é")).toBe(false);
  });

  test("builds a single OSC 9 sequence and strips control characters", () => {
    expect(osc9("am: alpha", "approval requested")).toBe("\x1b]9;am: alpha: approval requested\x07");
    const hostile = osc9("am: x", "a\x07\x1b]9;spoof\x07b\nc\u009cd é");
    expect(hostile).toBe("\x1b]9;am: x: a ]9;spoof b c d é\x07");
    expect(hostile.slice(1, -1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});

import { buildNotifyCommand, deliverNotification, type NotificationDelivery } from "../src/notify";
import { loadConfig } from "../src/config";

const prUrl = "https://github.com/owner/repo/pull/123";
const notifyConfig = { ...loadConfig(), notifyCommand: undefined, itermNotifications: true };
function delivery(overrides: Partial<NotificationDelivery> = {}) {
  const calls: { cmd: string[]; vars: Record<string, string>; options?: { keepAlive?: boolean } }[] = [];
  const warnings: string[] = [];
  let itermCalls = 0;
  const deps: NotificationDelivery = {
    platform: "darwin", has: () => true,
    run: async (cmd, vars, options) => { calls.push({ cmd, vars, ...(options ? { options } : {}) }); return 0; },
    iterm: () => { itermCalls++; return true; }, warn: message => { warnings.push(message); },
    ...overrides,
  };
  return { deps, calls, warnings, itermCalls: () => itermCalls };
}

describe("clickable PR notifications", () => {
  test("opens the validated PR through notifier's own identity, ahead of iTerm", async () => {
    const d = delivery();
    await deliverNotification("PR merged", "body", prUrl, notifyConfig, d.deps);
    expect(d.calls).toEqual([{ cmd: ["terminal-notifier", "-title", "PR merged", "-message", "body", "-open", prUrl], vars: { AM_TITLE: "PR merged", AM_MESSAGE: "body", AM_URL: prUrl }, options: { keepAlive: true } }]);
    expect(d.itermCalls()).toBe(0);
    expect(d.calls[0]!.cmd).not.toContain("-sender");
  });

  test("escapes property-list prefixes in terminal notifier messages", async () => {
    const d = delivery();
    await deliverNotification("PR merged", "[am] PR #123 merged", prUrl, notifyConfig, d.deps);
    expect(d.calls[0]!.cmd[4]).toBe("\\[am] PR #123 merged");
  });

  test("permission denial keeps the notification via iTerm and explains the failure", async () => {
    const d = delivery({ run: async () => 3 });
    await deliverNotification("PR merged", "body", prUrl, notifyConfig, d.deps);
    expect(d.itermCalls()).toBe(1);
    expect(d.warnings[0]).toContain("enable terminal-notifier");
  });

  test("missing notifier and tmux fall back to a plain notification", async () => {
    const d = delivery({ has: () => false, iterm: () => { throw new Error("tmux missing"); } });
    await deliverNotification("PR merged", "body", prUrl, notifyConfig, d.deps);
    expect(d.calls[0]!.cmd[0]).toBe("osascript");
  });

  test("invalid URL never becomes an open action or custom command variable", async () => {
    const d = delivery();
    await deliverNotification("PR", "body", "file:///private/file", { ...notifyConfig, notifyCommand: "my-notifier" }, d.deps);
    expect(d.calls[0]!.cmd).toEqual(["sh", "-c", "my-notifier"]);
    expect(d.calls[0]!.vars.AM_URL).toBe("");
    expect(buildNotifyCommand("PR", "body", notifyConfig, d.deps, "javascript:alert(1)")![0]).toBe("osascript");
  });

  test("custom notifier keeps precedence and receives the validated URL", async () => {
    const d = delivery();
    await deliverNotification("PR", "body", prUrl, { ...notifyConfig, notifyCommand: "my-notifier" }, d.deps);
    expect(d.calls[0]!.cmd).toEqual(["sh", "-c", "my-notifier"]);
    expect(d.calls[0]!.vars.AM_URL).toBe(prUrl);
    expect(d.itermCalls()).toBe(0);
  });

  test("legacy notifications retain the existing iTerm path", async () => {
    const d = delivery();
    await deliverNotification("Agent idle", "body", undefined, notifyConfig, d.deps);
    expect(d.calls).toHaveLength(0);
    expect(d.itermCalls()).toBe(1);
  });
});
