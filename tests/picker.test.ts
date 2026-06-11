import { describe, expect, test } from "bun:test";
import { clipAnsi, splitKeys, visibleWidth, wrapTokens } from "../src/picker";

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

describe("wrapTokens", () => {
  test("packs separator-delimited tokens into width-bounded lines", () => {
    expect(wrapTokens("a · b · c", 80)).toEqual(["a · b · c"]);
    expect(wrapTokens("aaaa · bbbb · cccc", 11)).toEqual(["aaaa · bbbb", "cccc"]);
  });

  test("an oversized single token still gets its own line", () => {
    expect(wrapTokens("tiny · enormous-token-here", 10)).toEqual(["tiny", "enormous-token-here"]);
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
    expect(clipped).toBe(`${RED}definitel…`);
  });

  test("never splits an escape sequence at the boundary", () => {
    const clipped = clipAnsi(`abc${BG}def`, 4);
    expect(clipped).toBe(`abc${BG}…`);
  });
});
