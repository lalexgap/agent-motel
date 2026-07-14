import { describe, expect, test } from "bun:test";
import {
  asFeedback,
  clipAnsi,
  cycleField,
  feedbackBanner,
  filterPaletteCommands,
  formFields,
  parseMouseEvent,
  splitKeys,
  visibleWidth,
  wrapTokens,
} from "../src/picker";

const GREEN = "\x1b[38;2;158;206;106m";
const YELLOW_C = "\x1b[38;2;224;175;104m";
const RED_C = "\x1b[38;2;247;118;142m";

const RED = "\x1b[31m";
const BG = "\x1b[48;5;236m";
const RESET = "\x1b[0m";

describe("visibleWidth", () => {
  test("ignores SGR escape sequences", () => {
    expect(visibleWidth("plain")).toBe(5);
    expect(visibleWidth(`${RED}red${RESET} text`)).toBe(8);
    expect(visibleWidth(`${BG}${RED}x${RESET}`)).toBe(1);
  });
});

describe("splitKeys", () => {
  test("splits batched arrows, printables, and enter", () => {
    expect(splitKeys("\x1b[A\x1b[A\r")).toEqual(["\x1b[A", "\x1b[A", "\r"]);
    expect(splitKeys("abc")).toEqual(["a", "b", "c"]);
  });

  test("bare esc stays a single key and CRLF collapses to one enter", () => {
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
    expect(splitKeys("\r\n")).toEqual(["\r"]);
  });

  test("application-mode (SS3) arrows normalize to CSI form", () => {
    expect(splitKeys("\x1bOC")).toEqual(["\x1b[C"]);
    expect(splitKeys("\x1bOA\x1bOB")).toEqual(["\x1b[A", "\x1b[B"]);
  });
});

describe("parseMouseEvent", () => {
  test("parses SGR button presses and one-based coordinates", () => {
    expect(parseMouseEvent("\x1b[<0;12;7M")).toEqual({
      button: 0,
      x: 12,
      y: 7,
      pressed: true,
    });
  });

  test("distinguishes releases and wheel events", () => {
    expect(parseMouseEvent("\x1b[<0;12;7m")?.pressed).toBe(false);
    expect(parseMouseEvent("\x1b[<64;2;3M")?.button).toBe(64);
  });

  test("rejects incomplete or unrelated input", () => {
    expect(parseMouseEvent("\x1b[<0;12M")).toBeNull();
    expect(parseMouseEvent("j")).toBeNull();
  });
});

describe("wrapTokens", () => {
  test("packs separator-delimited tokens into width-bounded lines", () => {
    expect(wrapTokens("a · b · c", 80)).toEqual(["a · b · c"]);
    expect(wrapTokens("aaaa · bbbb · cccc", 11)).toEqual(["aaaa · bbbb", "cccc"]);
  });

  test("an oversized single token still gets its own line", () => {
    expect(wrapTokens("tiny · enormous-token-here", 10)).toEqual(["tiny", "enormous-token-here"]);
  });
});

describe("asFeedback", () => {
  test("bare strings default to a success", () => {
    expect(asFeedback("stopped x")).toEqual({ text: "stopped x", level: "ok" });
  });
  test("passes structured results through and maps null", () => {
    expect(asFeedback({ text: "boom", level: "error" })).toEqual({ text: "boom", level: "error" });
    expect(asFeedback(null)).toBeNull();
    expect(asFeedback(undefined)).toBeNull();
  });
});

describe("feedbackBanner", () => {
  test("errors lead with ✕ and are colored red", () => {
    const cells = feedbackBanner({ text: "stop failed: nope", level: "error" }, 38);
    expect(cells[0]!.text).toBe("✕ stop failed: nope");
    expect(cells[0]!.style).toBe(RED_C);
  });

  test("warnings use ⚠ yellow, success uses ✓ green, info has no glyph", () => {
    expect(feedbackBanner({ text: "careful", level: "warn" }, 38)[0]).toMatchObject({ text: "⚠ careful", style: YELLOW_C });
    expect(feedbackBanner({ text: "done", level: "ok" }, 38)[0]).toMatchObject({ text: "✓ done", style: GREEN });
    expect(feedbackBanner({ text: "moving x…", level: "info" }, 38)[0]!.text).toBe("moving x…");
  });

  test("continuation lines indent to align under the glyph", () => {
    const cells = feedbackBanner({ text: "alpha bravo charlie delta echo foxtrot", level: "error" }, 16);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells[0]!.text.startsWith("✕ ")).toBe(true);
    expect(cells.slice(1).every((c) => c.text.startsWith("  "))).toBe(true);
  });

  test("strips control bytes from ssh stderr (keeps the words)", () => {
    const cells = feedbackBanner({ text: "boom\r\tbang\x07done", level: "error" }, 40);
    expect(cells.map((c) => c.text).join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
    expect(cells[0]!.text).toContain("bang");
  });

  test("errors get a taller ceiling than routine messages", () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const err = feedbackBanner({ text: long, level: "error" }, 10);
    const ok = feedbackBanner({ text: long, level: "ok" }, 10);
    expect(err.length).toBeGreaterThan(ok.length);
    expect(ok.length).toBeLessThanOrEqual(6);
    expect(err.length).toBeLessThanOrEqual(10);
  });
});

describe("formFields", () => {
  test("adds the where field (before dir) only when remotes exist", () => {
    expect(formFields(false)).toEqual(["name", "task", "dir", "provider", "model", "effort"]);
    expect(formFields(true)).toEqual(["name", "task", "where", "dir", "provider", "model", "effort"]);
  });
});

describe("cycleField", () => {
  test("wraps forward and backward", () => {
    expect(cycleField(0, 3, 1)).toBe(1);
    expect(cycleField(2, 3, 1)).toBe(0); // wrap forward
    expect(cycleField(0, 3, -1)).toBe(2); // wrap backward
    expect(cycleField(1, 4, -1)).toBe(0);
  });
  test("is safe with no fields", () => {
    expect(cycleField(0, 0, 1)).toBe(0);
  });
});

describe("filterPaletteCommands", () => {
  const commands = [
    { id: "create", label: "Create agent", keywords: "new spawn", shortcut: "n" },
    { id: "search", label: "Search conversations", keywords: "chat transcript", shortcut: "/" },
    { id: "all", label: "Show exited agents", keywords: "all dead stopped", shortcut: "a" },
    { id: "stop", label: "Stop api", keywords: "exit kill", shortcut: "e x" },
  ];

  test("matches labels, keywords, shortcuts, and multiple terms", () => {
    expect(filterPaletteCommands(commands, "").map((c) => c.id)).toEqual(["create", "search", "all", "stop"]);
    expect(filterPaletteCommands(commands, "spawn").map((c) => c.id)).toEqual(["create"]);
    expect(filterPaletteCommands(commands, "search chat").map((c) => c.id)).toEqual(["search"]);
    expect(filterPaletteCommands(commands, "e x").map((c) => c.id)).toEqual(["stop"]);
    expect(filterPaletteCommands(commands, "stop").map((c) => c.id)).toEqual(["stop", "all"]);
  });
});

describe("clipAnsi", () => {
  test("passes lines that fit through unchanged", () => {
    const line = `${RED}short${RESET}`;
    expect(clipAnsi(line, 10)).toBe(line);
    expect(clipAnsi(line, 5)).toBe(line);
  });

  test("clips by visible width, keeping escapes intact", () => {
    const clipped = clipAnsi(`${RED}definitely too long${RESET}`, 10);
    expect(visibleWidth(clipped)).toBe(10);
    expect(clipped).toBe(`${RED}definitel…${RESET}`);
  });

  test("never splits an escape sequence at the boundary", () => {
    const clipped = clipAnsi(`abc${BG}def`, 4);
    expect(clipped).toBe(`abc…${BG}`);
  });

  test("preserves styles past the clip point so padding keeps the row's colors", () => {
    // Emulates a form row: typed value, cursor-block bg, row-base restore.
    // Dropping the trailing restore leaked the cursor bg into the padding.
    const clipped = clipAnsi(`${BG}typed value that overflows${RESET}tail`, 10);
    expect(visibleWidth(clipped)).toBe(10);
    expect(clipped.endsWith(RESET)).toBe(true);
  });
});
