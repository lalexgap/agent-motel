import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_START,
  notificationsAfter,
  planRelayDisplay,
  readNotifications,
  readRelayCursors,
  recordNotification,
  writeRelayCursor,
  type NotificationEntry,
} from "../src/notifications";
import { relayOnce, type RelayDeps } from "../src/notificationRelay";
import { notify } from "../src/notify";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-notifications-"));
  process.env.AGENTMGR_HOME = home;
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true", hostAlias: "laptop" }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function entry(id: string, at: string, agent = "a"): NotificationEntry {
  return { id, at, host: "gapserver", agent, kind: "attention", title: `am: ${agent}`, message: `msg ${id}` };
}

describe("journal", () => {
  test("notify() records an entry with host, agent and kind", () => {
    notify("am: alpha", "approval requested — Bash", { agent: "alpha", kind: "attention" });
    const [e] = readNotifications();
    expect(e).toMatchObject({ host: "laptop", agent: "alpha", kind: "attention", title: "am: alpha", message: "approval requested — Bash" });
    expect(typeof e!.id).toBe("string");
  });

  test("trims to the newest entries once the file grows large", () => {
    const big = "x".repeat(1000);
    for (let i = 0; i < 300; i++) recordNotification({ host: "h", kind: "idle", title: "t", message: `${i} ${big}` });
    const entries = readNotifications();
    expect(entries.length).toBeLessThan(300);
    expect(entries.at(-1)!.message.startsWith("299 ")).toBe(true);
  });

  test("skips torn lines", () => {
    recordNotification({ host: "h", kind: "idle", title: "t", message: "ok" });
    writeFileSync(join(home, "notifications.jsonl"), readNotifications().map((e) => JSON.stringify(e)).join("\n") + "\n{\"id\":", { flag: "w" });
    expect(readNotifications().map((e) => e.message)).toEqual(["ok"]);
  });
});

describe("notificationsAfter", () => {
  const entries = [entry("1", "2026-01-01T00:00:00Z"), entry("2", "2026-01-01T00:00:01Z"), entry("3", "2026-01-01T00:00:02Z")];

  test("a fresh subscriber gets the current position, not history", () => {
    expect(notificationsAfter(entries, undefined)).toEqual({ entries: [], cursor: "3" });
  });

  test("returns entries after the cursor and advances it", () => {
    expect(notificationsAfter(entries, "1")).toEqual({ entries: entries.slice(1), cursor: "3" });
    expect(notificationsAfter(entries, "3")).toEqual({ entries: [], cursor: "3" });
  });

  test("a trimmed-away cursor returns every survivor", () => {
    expect(notificationsAfter(entries, "gone").entries.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  test("an empty journal hands out a start cursor that later sees the first entry", () => {
    const first = notificationsAfter([], undefined);
    expect(first).toEqual({ entries: [], cursor: JOURNAL_START });
    expect(notificationsAfter([], first.cursor)).toEqual({ entries: [], cursor: JOURNAL_START });
    expect(notificationsAfter(entries.slice(0, 1), first.cursor)).toEqual({ entries: entries.slice(0, 1), cursor: "1" });
  });
});

describe("planRelayDisplay", () => {
  const now = Date.parse("2026-01-01T01:00:00Z");

  test("shows recent entries individually, labelled with the host", () => {
    const shown = planRelayDisplay("gapserver", [entry("1", "2026-01-01T00:59:30Z", "alpha")], now);
    expect(shown).toEqual([{ title: "am: alpha (gapserver)", message: "msg 1" }]);
  });

  test("collapses stale entries into one summary", () => {
    const shown = planRelayDisplay("gapserver", [
      entry("1", "2026-01-01T00:10:00Z", "alpha"),
      entry("2", "2026-01-01T00:20:00Z", "beta"),
      entry("3", "2026-01-01T00:59:00Z", "gamma"),
    ], now);
    expect(shown).toEqual([
      { title: "am (gapserver)", message: "2 earlier notifications: alpha, beta" },
      { title: "am: gamma (gapserver)", message: "msg 3" },
    ]);
  });

  test("caps a burst of recent entries", () => {
    const burst = Array.from({ length: 7 }, (_, i) => entry(String(i), "2026-01-01T00:59:59Z", `agent${i}`));
    const shown = planRelayDisplay("gapserver", burst, now);
    expect(shown).toHaveLength(5);
    expect(shown[0]!.message).toBe("3 earlier notifications: agent0, agent1, agent2");
  });
});

describe("relayOnce", () => {
  function deps(stdout: string, exitCode = 0) {
    const shown: string[] = [];
    const calls: string[][] = [];
    const cursors: Record<string, string> = {};
    const d: RelayDeps = {
      run: async (_host, args) => {
        calls.push(args);
        return { exitCode, stdout, stderr: "" };
      },
      show: (title, message) => shown.push(`${title}|${message}`),
      cursor: (host) => cursors[host],
      saveCursor: (host, cursor) => { cursors[host] = cursor; },
      now: () => Date.parse("2026-01-01T01:00:00Z"),
    };
    return { d, shown, calls, cursors };
  }

  test("first contact records the cursor without showing anything", async () => {
    const { d, shown, calls, cursors } = deps(JSON.stringify({ entries: [], cursor: "9" }));
    expect(await relayOnce("gapserver", d, 1)).toBe(true);
    expect(calls[0]).toEqual(["__notifications", "--wait", "1"]);
    expect(shown).toEqual([]);
    expect(cursors.gapserver).toBe("9");
  });

  test("a reply without a cursor is a failure, so the loop backs off", async () => {
    const { d, cursors } = deps(JSON.stringify({ entries: [] }));
    expect(await relayOnce("gapserver", d, 1)).toBe(false);
    expect(cursors.gapserver).toBeUndefined();
  });

  test("shows new entries and advances the cursor", async () => {
    const { d, shown, calls, cursors } = deps(JSON.stringify({ entries: [entry("10", "2026-01-01T00:59:50Z", "alpha")], cursor: "10" }));
    d.saveCursor("gapserver", "9");
    expect(await relayOnce("gapserver", d, 1)).toBe(true);
    expect(calls[0]).toEqual(["__notifications", "--after", "9", "--wait", "1"]);
    expect(shown).toEqual(["am: alpha (gapserver)|msg 10"]);
    expect(cursors.gapserver).toBe("10");
  });

  test("never re-shows this host's own entries", async () => {
    const own = { ...entry("10", "2026-01-01T00:59:50Z"), host: "laptop" };
    const { d, shown } = deps(JSON.stringify({ entries: [own], cursor: "10" }));
    d.saveCursor("gapserver", "9");
    await relayOnce("gapserver", d, 1);
    expect(shown).toEqual([]);
  });

  test("reports failure for an unreachable or old remote", async () => {
    expect(await relayOnce("gapserver", deps("", 255).d, 1)).toBe(false);
    expect(await relayOnce("gapserver", deps("unknown command: __notifications").d, 1)).toBe(false);
  });

  test("relay cursors persist per host", () => {
    writeRelayCursor("gapserver", "a");
    writeRelayCursor("other", "b");
    expect(readRelayCursors()).toEqual({ gapserver: "a", other: "b" });
  });
});
