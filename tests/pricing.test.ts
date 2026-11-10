import { describe, expect, test } from "bun:test";
import { bucketKey, contextWindowFor, costBreakdown, costUSD, normalizeModelId, priceFor } from "../src/pricing";

// [calls, input, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking]
const counts = (input: number, output: number, cacheRead: number, write5m: number, write1h: number) => [
  1,
  input,
  write5m,
  write1h,
  cacheRead,
  output,
  0,
];

describe("pricing", () => {
  test("looks up models after stripping date suffixes and [1m]", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(priceFor("claude-opus-4-7")?.input).toBe(5);
    expect(priceFor("claude-sonnet-4-6-20260101")?.output).toBe(15);
    expect(priceFor("claude-fable-5-1[1m]")?.cacheRead).toBe(0.25);
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindowFor("claude-opus-5-5[1m]")).toBe(1_000_000);
  });

  test("unknown models have no price and no window", () => {
    for (const model of ["gpt-5.5-codex", "gemini-3-pro", "<synthetic>", "claude-opus-9", undefined]) {
      expect(priceFor(model)).toBeUndefined();
      expect(contextWindowFor(model)).toBeUndefined();
      expect(costUSD(counts(1000, 1000, 0, 0, 0), bucketKey(model))).toBeUndefined();
    }
  });

  test("fast mode doubles every rate for eligible models only", () => {
    const c = counts(1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    const base = costUSD(c, bucketKey("claude-opus-5-5"))!;
    expect(base).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6);
    expect(costUSD(c, bucketKey("claude-opus-5-5", { fast: true }))).toBeCloseTo(base * 2, 6);
    expect(costUSD(c, bucketKey("claude-fable-5-2", { fast: true }))).toBeCloseTo((8 + 40 + 0.2 + 10 + 16) * 2, 6);
    expect(costUSD(c, bucketKey("claude-mythos-5-2", { fast: true }))).toBeCloseTo((8 + 40 + 0.2 + 10 + 16) * 2, 6);
    expect(costUSD(c, bucketKey("claude-opus-5", { fast: true }))).toBeCloseTo((5 + 25 + 0.5 + 6.25 + 10) * 2, 6);
    expect(costUSD(c, bucketKey("claude-opus-4-8", { fast: true }))).toBeCloseTo((5 + 25 + 0.5 + 6.25 + 10) * 2, 6);
    // Not a fast-mode model: no multiplier.
    expect(costUSD(c, bucketKey("claude-sonnet-4-6", { fast: true }))).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6, 6);
  });

  test("haiku 5.5 long prompts cost 5x", () => {
    const c = counts(1_000_000, 1_000_000, 0, 0, 0);
    expect(costUSD(c, bucketKey("claude-haiku-5-5"))).toBeCloseTo(0.6, 6);
    expect(costUSD(c, bucketKey("claude-haiku-5-5", { long: true }))).toBeCloseTo(3, 6);
    expect(costUSD(c, bucketKey("claude-haiku-4-5", { long: true }))).toBeCloseTo(6, 6);
  });

  test("breakdown classes sum to the total", () => {
    const b = costBreakdown(counts(10, 20, 30, 40, 50), "claude-opus-5")!;
    expect(b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h).toBeCloseTo(b.total, 12);
  });

  test("reproduces Claude Code's own per-model totals", () => {
    const opus = costUSD(counts(383_323, 659_395, 152_058_746, 3_851_658, 529_104), "claude-opus-5-5")!;
    expect(Math.abs(opus - 68.6241)).toBeLessThan(0.005);
    const fable = costUSD(counts(27_303, 87_877, 16_859_986, 112_141, 324_408), "claude-fable-5-1")!;
    expect(Math.abs(fable - 16.7718)).toBeLessThan(0.005);
  });
});
