import { describe, expect, test } from "bun:test";
import { paneLooksWaiting } from "../src/commands/ls";

describe("paneLooksWaiting", () => {
  test("detects scheduled wake-ups and background tasks", () => {
    expect(paneLooksWaiting(["❯ ", "✶ next wake-up in 4m (watching CI)"])).toBe(true);
    expect(paneLooksWaiting(["⏺ Done.", "1 background task running"])).toBe(true);
    expect(paneLooksWaiting(["2 bashes running", "❯ "])).toBe(true);
  });

  test("a plain idle prompt is not waiting", () => {
    expect(paneLooksWaiting(["⏺ Done. The tests pass.", "❯ "])).toBe(false);
    expect(paneLooksWaiting([])).toBe(false);
  });

  test("only the visible tail of the pane counts", () => {
    const lines = ["next wake-up in 4m", ...Array(30).fill("other output")];
    expect(paneLooksWaiting(lines)).toBe(false);
  });
});
