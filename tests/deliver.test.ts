import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDeliverLock,
  paneBusy,
  releaseDeliverLock,
  __lockPath,
  __lockStaleMs,
} from "../src/deliver";
import { ensureDirs } from "../src/paths";

const SEP = "─".repeat(120);

// A Claude Code pane actively generating: a present-tense spinner and the
// "esc to interrupt" hint in the footer (captured from a real session).
const GENERATING = [
  "  Determining the right approach…",
  "✽ Determining… (1m 17s · ↓ 4.9k tokens)",
  SEP,
  "❯ ",
  SEP,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt",
];

// The same agent finished: a PAST-tense summary, an interactive input box, and
// NO interrupt hint — even though its status file might still say "working".
const IDLE = [
  "  Everything is written up in the plan.",
  "✻ Worked for 8m 39s",
  SEP,
  "❯ ",
  SEP,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #9 · ← for agents",
];

describe("paneBusy", () => {
  test("true while generating (esc-to-interrupt footer)", () => {
    expect(paneBusy(GENERATING)).toBe(true);
  });

  test("false at an idle prompt, even after a long turn", () => {
    expect(paneBusy(IDLE)).toBe(false);
  });

  test("ignores an 'esc to interrupt' sitting up in scrollback", () => {
    const scrollback = [
      "  the tip said: press esc to interrupt a running turn",
      "  ...several lines of conversation below it...",
      "  more output",
      "✻ Worked for 12s",
      SEP,
      "❯ ",
      SEP,
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ];
    expect(paneBusy(scrollback)).toBe(false);
  });

  test("sees through SGR color codes in the footer", () => {
    const colored = [...IDLE.slice(0, 5), "  \x1b[2mstatus\x1b[0m · \x1b[33mesc to interrupt\x1b[0m"];
    expect(paneBusy(colored)).toBe(true);
  });
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("delivery lock", () => {
  test("is mutually exclusive while held, and frees on release", () => {
    expect(acquireDeliverLock("api")).toBe(true);
    expect(acquireDeliverLock("api")).toBe(false); // already held
    expect(acquireDeliverLock("other")).toBe(true); // per-agent, independent
    releaseDeliverLock("api");
    expect(acquireDeliverLock("api")).toBe(true); // freed
  });

  test("a stale lock (crashed holder) is reclaimed; a fresh one is not", () => {
    expect(acquireDeliverLock("api")).toBe(true);
    // fresh → a second caller can't steal
    expect(acquireDeliverLock("api")).toBe(false);
    // backdate the lock past the staleness window → now stealable
    const old = (Date.now() - __lockStaleMs - 5000) / 1000;
    utimesSync(__lockPath("api"), old, old);
    expect(acquireDeliverLock("api")).toBe(true); // stolen, and read-back confirms ownership
    // having stolen it, it's now fresh again → not re-stealable
    expect(acquireDeliverLock("api")).toBe(false);
  });
});
