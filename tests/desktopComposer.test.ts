import { describe, expect, test } from "bun:test";
import {
  AMBIGUOUS_SEND,
  bubbles,
  cancelOutcome,
  capDrafts,
  DRAFT_MAX_CHARS,
  DRAFT_MAX_COUNT,
  DRAFTS_MAX_TOTAL_CHARS,
  modeFor,
  normalizeMessage,
  notePending,
  parseDrafts,
  parseModePreference,
  PENDING_TTL_MS,
  putDraft,
  reconcilePending,
  rejectionOutcome,
  sendModeFor,
  sendOutcome,
  textAfterSend,
  TOKEN_REJECTED,
  type PendingMessage,
} from "../desktop/src/composer";
import type { TranscriptEntry } from "../desktop/src/types";

let index = 0;
const user = (text: string): TranscriptEntry => ({ index: index++, kind: "user", text });
const assistant = (text: string): TranscriptEntry => ({ index: index++, kind: "assistant", text });
const T0 = 1_700_000_000_000;

describe("pending messages", () => {
  test("normalises whitespace and pasted-content wrappers", () => {
    expect(normalizeMessage("  a\n\n b\tc ")).toBe("a b c");
    expect(normalizeMessage('<pasted_content id="p1">x  y</pasted_content>')).toBe("x y");
  });

  test("a pending message clears once a later user turn matches it", () => {
    const before = [user("start"), assistant("ok")];
    let pending = notePending([], "check   the\nlogs", "01A", 1, T0);
    pending = reconcilePending(pending, before, T0 + 1000);
    expect(pending).toHaveLength(1);
    pending = reconcilePending(pending, [...before, user("check the logs"), assistant("done")], T0 + 2000);
    expect(pending).toEqual([]);
  });

  test("an older identical user turn does not clear it", () => {
    const entries = [user("again"), assistant("ok")];
    const pending = notePending([], "again", "01A", 1, T0);
    expect(reconcilePending(pending, entries, T0 + 1)).toHaveLength(1);
  });

  test("a delivered turn with extra text after it (attachments) still matches", () => {
    const pending = notePending([], "look", undefined, 0, T0);
    expect(reconcilePending(pending, [user("look\n[image: /tmp/x.png]")], T0 + 1)).toEqual([]);
  });

  test("two identical sends need two turns", () => {
    let pending = notePending(notePending([], "ping", "01A", 0, T0), "ping", "01B", 0, T0 + 1);
    pending = reconcilePending(pending, [user("ping")], T0 + 2);
    expect(pending.map((item) => item.id)).toEqual(["01B"]);
    expect(reconcilePending(pending, [user("ping"), user("ping")], T0 + 3)).toEqual([]);
  });

  test("expires after 30 minutes", () => {
    const pending = notePending([], "slow", undefined, 0, T0);
    expect(reconcilePending(pending, [], T0 + PENDING_TTL_MS - 1)).toHaveLength(1);
    expect(reconcilePending(pending, [], T0 + PENDING_TTL_MS)).toEqual([]);
  });

  test("a new session (fewer user turns than the baseline) resets the baseline", () => {
    const pending = notePending([], "hello", undefined, 5, T0);
    expect(reconcilePending(pending, [user("hello")], T0 + 1)).toEqual([]);
    const kept = reconcilePending(pending, [user("other")], T0 + 1);
    expect(kept[0]!.baseline).toBe(0);
  });
});

describe("bubbles", () => {
  const pending = (id: string | undefined, text: string): PendingMessage => ({ ...(id ? { id } : {}), match: text, shown: text, at: T0, baseline: 0 });

  test("pending first as sent, then the queue as queued; cancellable with an id", () => {
    const list = bubbles([pending("01A", "now one")], [{ msgId: "01Q", text: "queued one" }, { message: "legacy" }]);
    expect(list.map(({ text, state, cancelId }) => ({ text, state, cancelId }))).toEqual([
      { text: "now one", state: "sent", cancelId: undefined },
      { text: "queued one", state: "queued", cancelId: "01Q" },
      { text: "legacy", state: "queued", cancelId: undefined },
    ]);
  });

  test("a pending message that is in the queue is shown once, as queued", () => {
    const list = bubbles([pending("01A", "hold this")], [{ msgId: "01A", text: "hold this" }]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: "queued", cancelId: "01A" });
  });

  test("keys are stable and unique per message", () => {
    const a = bubbles([pending(undefined, "x")], [{ text: "y" }, { msgId: "01Q", text: "z" }]);
    const b = bubbles([pending(undefined, "x")], [{ text: "y" }, { msgId: "01Q", text: "z" }]);
    expect(a.map((bubble) => bubble.key)).toEqual(b.map((bubble) => bubble.key));
    expect(new Set(a.map((bubble) => bubble.key)).size).toBe(3);
    expect(bubbles([], undefined)).toEqual([]);
    expect(bubbles([], [{}])[0]!.text).toBe("Queued message");
  });
});

describe("send mode", () => {
  test("claude and codex default to now; others to queue", () => {
    expect(modeFor("claude", null)).toEqual({ mode: "now", choosable: true });
    expect(modeFor("codex", null)).toEqual({ mode: "now", choosable: true });
    expect(modeFor(undefined, null)).toEqual({ mode: "queue", choosable: true });
  });
  test("the saved preference wins where both modes are allowed", () => {
    expect(modeFor("claude", "queue")).toEqual({ mode: "queue", choosable: true });
    expect(modeFor("codex", "now")).toEqual({ mode: "now", choosable: true });
  });
  test("antigravity is always queue", () => {
    expect(modeFor("antigravity", null)).toEqual({ mode: "queue", choosable: false });
    expect(modeFor("antigravity", "now")).toEqual({ mode: "queue", choosable: false });
  });
  test("⌥Enter flips the mode once, never past a forced queue", () => {
    expect(sendModeFor({ mode: "now", choosable: true }, false)).toBe("now");
    expect(sendModeFor({ mode: "now", choosable: true }, true)).toBe("queue");
    expect(sendModeFor({ mode: "queue", choosable: true }, true)).toBe("now");
    expect(sendModeFor({ mode: "queue", choosable: false }, true)).toBe("queue");
  });
  test("preference parsing", () => {
    expect(parseModePreference("now")).toBe("now");
    expect(parseModePreference("queue")).toBe("queue");
    expect(parseModePreference("interrupt")).toBeNull();
    expect(parseModePreference(null)).toBeNull();
  });
});

describe("text after a send", () => {
  test("unchanged text clears", () => {
    expect(textAfterSend("hello", "hello")).toEqual({ text: "", removed: 5 });
  });
  test("text typed after the send started is kept", () => {
    expect(textAfterSend("hello\nand more", "hello")).toEqual({ text: "and more", removed: 6 });
  });
  test("an edited box is left alone", () => {
    expect(textAfterSend("hullo", "hello")).toEqual({ text: "hullo", removed: 0 });
    expect(textAfterSend("", "hello")).toEqual({ text: "", removed: 0 });
  });
});

describe("drafts", () => {
  test("put, clear and parse", () => {
    let drafts = putDraft({}, "c/a", "half a thought", T0);
    expect(drafts).toEqual({ "c/a": { text: "half a thought", at: T0 } });
    expect(parseDrafts(JSON.stringify(drafts))).toEqual(drafts);
    drafts = putDraft(drafts, "c/a", "   ", T0 + 1);
    expect(drafts).toEqual({});
  });
  test("bad storage is ignored", () => {
    expect(parseDrafts(null)).toEqual({});
    expect(parseDrafts("{")).toEqual({});
    expect(parseDrafts("[]")).toEqual({});
    expect(parseDrafts(JSON.stringify({ a: { text: 3, at: 1 }, b: { text: "ok", at: 2 }, c: null }))).toEqual({ b: { text: "ok", at: 2 } });
  });
  test("keeps the newest within the count cap", () => {
    let drafts = {};
    for (let i = 0; i < DRAFT_MAX_COUNT + 5; i++) drafts = putDraft(drafts, `c/${i}`, `draft ${i}`, T0 + i);
    const keys = Object.keys(drafts);
    expect(keys).toHaveLength(DRAFT_MAX_COUNT);
    expect(keys).not.toContain("c/0");
    expect(keys).toContain(`c/${DRAFT_MAX_COUNT + 4}`);
  });
  test("size caps: an oversized draft is not stored, the total is bounded", () => {
    expect(putDraft({}, "c/big", "x".repeat(DRAFT_MAX_CHARS + 1), T0)).toEqual({});
    const drafts: Record<string, { text: string; at: number }> = {};
    for (let i = 0; i < 8; i++) drafts[`c/${i}`] = { text: "y".repeat(DRAFT_MAX_CHARS), at: T0 + i };
    const kept = capDrafts(drafts);
    const total = Object.values(kept).reduce((sum, draft) => sum + draft.text.length, 0);
    expect(total).toBeLessThanOrEqual(DRAFTS_MAX_TOTAL_CHARS);
    expect(Object.keys(kept)).toContain("c/7");
    expect(Object.keys(kept)).not.toContain("c/0");
  });
});

describe("error sentences", () => {
  test("send", () => {
    expect(sendOutcome({ status: 200, body: { ok: true, mode: "now", id: "01A" } })).toEqual({ error: null });
    expect(sendOutcome({ status: 401, body: { error: "unauthorized" } })).toEqual({ error: TOKEN_REJECTED, tokenRejected: true });
    expect(sendOutcome({ status: 404, body: { error: "no agent" } }).error).toBe("This agent no longer exists");
    expect(sendOutcome({ status: 409, body: { error: "x", reason: "no_session" } }).error).toBe("The agent has no live session");
    expect(sendOutcome({ status: 409, body: { error: "x", reason: "mailbox_busy" } }).error).toBe("The agent's mailbox is busy; try again");
    expect(sendOutcome({ status: 409, body: { error: "x", reason: "remote_too_old" } }).error).toBe("The remote host's am is too old for this");
    expect(sendOutcome({ status: 409, body: { error: "message to \"a\" was not sent", reason: "not_delivered" } }).error).toBe("message to \"a\" was not sent");
    expect(sendOutcome({ status: 400, body: { error: "text required" } }).error).toBe("text required");
    expect(sendOutcome({ status: 302, body: null }).error).toMatch(/redirected/);
    expect(sendOutcome({ status: 502, body: null }).error).toMatch(/may or may not have been sent/);
  });
  test("cancel", () => {
    expect(cancelOutcome({ status: 200, body: { ok: true, state: "cancelled" } })).toEqual({ error: null });
    expect(cancelOutcome({ status: 404, body: { error: "gone" } })).toEqual({ error: null, gone: true });
    expect(cancelOutcome({ status: 409, body: { error: "x", reason: "already_delivered", state: "delivered" } }).error).toBe("Already delivered");
    expect(cancelOutcome({ status: 409, body: { error: "x", reason: "mailbox_busy" } }).error).toBe("The agent's mailbox is busy; try again");
    expect(cancelOutcome({ status: 409, body: { error: "server words", reason: "unknown" } }).error).toBe("server words");
    expect(cancelOutcome({ status: 401, body: null }).tokenRejected).toBe(true);
  });
  test("bridge rejections: validation is definite, anything else is ambiguous and not retried", () => {
    expect(rejectionOutcome(new Error("Message is too long (limit 100,000 bytes)"), "send").error).toBe("Message is too long (limit 100,000 bytes)");
    expect(rejectionOutcome(new Error("invalid agent: a/b"), "send").error).toBe("invalid agent: a/b");
    expect(rejectionOutcome(new Error("unknown connection: x"), "send").error).toBe("unknown connection: x");
    expect(rejectionOutcome(new Error("Unable to connect. Is the computer able to access the url?"), "send").error).toBe(AMBIGUOUS_SEND);
    expect(rejectionOutcome(new Error("The operation timed out."), "send").error).toBe(AMBIGUOUS_SEND);
    expect(rejectionOutcome("Dev bridge unreachable", "send").error).toBe(AMBIGUOUS_SEND);
    expect(rejectionOutcome(new Error("offline"), "cancel").error).toMatch(/cancel/);
  });
});
