import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_START,
  notificationPrUrl,
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
import { notifyPrEvent } from "../src/prMonitor";

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

const PR_URL = "https://github.com/owner/repo/pull/123";

describe("notificationPrUrl", () => {
  test("accepts only canonical GitHub pull request URLs", () => {
    expect(notificationPrUrl(PR_URL)).toBe(PR_URL);
    expect(notificationPrUrl("https://github.com/acme-inc/repo.name/pull/123")).toBe("https://github.com/acme-inc/repo.name/pull/123");
    for (const value of [
      undefined,
      123,
      "http://github.com/owner/repo/pull/123",
      "javascript:alert(1)",
      "file:///tmp/secret",
      "https://user:pass@github.com/owner/repo/pull/123",
      "https://github.com.evil.test/owner/repo/pull/123",
      "https://github.com:443/owner/repo/pull/123",
      "https://github.com/owner/repo/pull/123/",
      "https://github.com/owner/repo/pull/123?diff=split",
      "https://github.com/owner/repo/pull/123#discussion",
      "https://github.com/owner/repo/pull/0",
      "https://github.com/owner/repo/pull/01",
      "https://github.com/owner/repo/pull/9007199254740992",
      "https://github.com/owner/../pull/123",
      "https://github.com/../repo/pull/123",
      "https://github.com/owner/repo/pull/123\nhttps://evil.test",
    ]) expect(notificationPrUrl(value)).toBeUndefined();
  });
});

describe("journal", () => {
  test("notify() records an entry with host, agent and kind", () => {
    notify("am: alpha", "approval requested — Bash", { agent: "alpha", kind: "attention" });
    const [e] = readNotifications();
    expect(e).toMatchObject({ host: "laptop", agent: "alpha", kind: "attention", title: "am: alpha", message: "approval requested — Bash" });
    expect(typeof e!.id).toBe("string");
  });

  test("PR notifications retain owner and kind in the journal", () => {
    notifyPrEvent("alpha", "PR merged", PR_URL);
    expect(readNotifications().at(-1)).toMatchObject({ host: "laptop", agent: "alpha", kind: "pr", message: "PR merged", url: PR_URL });
  });

  test("records validated PR URLs and omits invalid metadata", () => {
    recordNotification({ host: "h", kind: "pr", title: "valid", message: "valid", url: PR_URL });
    recordNotification({ host: "h", kind: "pr", title: "invalid", message: "invalid", url: "javascript:alert(1)" });
    expect(readNotifications().map((e) => e.url)).toEqual([PR_URL, undefined]);
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
    const recent = { ...entry("1", "2026-01-01T00:59:30Z", "alpha"), url: PR_URL };
    const shown = planRelayDisplay("gapserver", [recent], now);
    expect(shown).toEqual([{ title: "am: alpha (gapserver)", message: "msg 1", url: PR_URL }]);
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
    expect(shown[0]!.url).toBeUndefined();
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
      show: (title, message, url) => shown.push(`${title}|${message}|${url ?? ""}`),
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
    expect(shown).toEqual(["am: alpha (gapserver)|msg 10|"]);
    expect(cursors.gapserver).toBe("10");
  });

  test("relays validated PR notifications", async () => {
    const pr = { ...entry("10", "2026-01-01T00:59:50Z", "alpha"), kind: "pr" as const, url: PR_URL };
    const { d, shown } = deps(JSON.stringify({ entries: [pr], cursor: "10" }));
    d.saveCursor("gapserver", "9");
    expect(await relayOnce("gapserver", d, 1)).toBe(true);
    expect(shown).toEqual([`am: alpha (gapserver)|msg 10|${PR_URL}`]);
  });

  test("shows remote entries without a click action when URL metadata is missing or invalid", async () => {
    for (const url of [undefined, "javascript:alert(1)", "https://github.com/owner/repo/pull/1?x=1"]) {
      const remote = { ...entry("10", "2026-01-01T00:59:50Z", "alpha"), kind: "pr" as const, ...(url ? { url } : {}) };
      const { d, shown } = deps(JSON.stringify({ entries: [remote], cursor: "10" }));
      d.saveCursor("gapserver", "9");
      expect(await relayOnce("gapserver", d, 1)).toBe(true);
      expect(shown).toEqual(["am: alpha (gapserver)|msg 10|"]);
    }
  });

  test("drops relay entries with unknown notification kinds", async () => {
    const invalid = { ...entry("10", "2026-01-01T00:59:50Z"), kind: "unknown" };
    const { d, shown } = deps(JSON.stringify({ entries: [invalid], cursor: "10" }));
    d.saveCursor("gapserver", "9");
    expect(await relayOnce("gapserver", d, 1)).toBe(true);
    expect(shown).toEqual([]);
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
