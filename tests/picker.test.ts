import { describe, expect, test } from "bun:test";
import { clipAnsi, splitKeys, visibleWidth } from "../src/picker";

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
