import { describe, expect, test } from "bun:test";
import { paneWaitingInfo } from "../src/commands/ls";

const SEP = "─".repeat(40);

describe("paneWaitingInfo", () => {
  test("detects indicators in the status region with display detail", () => {
    const info = paneWaitingInfo(["⏺ Done.", SEP, "❯ ", SEP, "  ✶ next wake-up in 4m (watching CI)"]);
    expect(info.waiting).toBe(true);
    expect(info.detail).toBe("next wake-up in 4m (watching CI)");

    expect(paneWaitingInfo([SEP, "1 background task running"]).waiting).toBe(true);
    expect(paneWaitingInfo([SEP, "2 bashes running · 30k tokens"]).detail).toBe("2 bashes running · 30k tokens");
  });

  test("conversation text above the separator can't false-positive", () => {
    const info = paneWaitingInfo(["⏺ I started a background task for you.", SEP, "❯ ", SEP, "  42k tokens"]);
    expect(info.waiting).toBe(false);
  });

  test("strips SGR color codes from matches", () => {
    const info = paneWaitingInfo([SEP, "\x1b[2m✶ wake-up in 90s\x1b[0m"]);
    expect(info.waiting).toBe(true);
    expect(info.detail).toBe("wake-up in 90s");
  });

  test("no separator falls back to the last few lines only", () => {
    expect(paneWaitingInfo(["background task mentioned early", "a", "b", "c", "d", "e"]).waiting).toBe(false);
    expect(paneWaitingInfo(["a", "b", "1 background task running"]).waiting).toBe(true);
  });

  test("plain idle panes are not waiting", () => {
    expect(paneWaitingInfo([SEP, "  ⏵⏵ auto mode on · 30k tokens"]).waiting).toBe(false);
  });
});
