// Prices from the claude-api skill table cached 2026-11-03; update here when prices change.

export interface ModelPrice {
  // $ per million tokens.
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  contextWindow: number;
}

const M = 1_000_000;
const K = 1_000;

function price(input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, contextWindow: number): ModelPrice {
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead, contextWindow };
}

const PRICES: Record<string, ModelPrice> = {};
function define(ids: string[], p: ModelPrice): void {
  for (const id of ids) PRICES[id] = p;
}
define(["claude-fable-5-2", "claude-mythos-5-2"], price(8, 40, 10, 16, 0.2, M));
define(["claude-fable-5-1", "claude-mythos-5-1"], price(10, 50, 12.5, 20, 0.25, M));
define(["claude-fable-5", "claude-mythos-5"], price(10, 50, 12.5, 20, 1, M));
define(["claude-opus-5-5"], price(4, 20, 5, 8, 0.2, M));
define(["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"], price(5, 25, 6.25, 10, 0.5, M));
define(["claude-sonnet-5-5"], price(2, 10, 2.5, 4, 0.1, M));
define(["claude-sonnet-5"], price(2, 10, 2.5, 4, 0.2, M));
define(["claude-sonnet-4-6"], price(3, 15, 3.75, 6, 0.3, M));
define(["claude-haiku-5-5"], price(0.1, 0.5, 0.125, 0.2, 0.01, M));
define(["claude-haiku-4-5"], price(1, 5, 1.25, 2, 0.1, 200 * K));

const FAST_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-2", "claude-mythos-5-2"]);
const FAST_MULTIPLIER = 2;
const LONG_PROMPT_MODELS = new Set(["claude-haiku-5-5"]);
const LONG_PROMPT_TOKENS = 100_000;
const LONG_PROMPT_MULTIPLIER = 5;

export function normalizeModelId(model: string | undefined): string {
  if (!model) return "unknown";
  return model.trim().replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "") || "unknown";
}

export function priceFor(model: string | undefined): ModelPrice | undefined {
  return PRICES[normalizeModelId(model)];
}

export function contextWindowFor(model: string | undefined): number | undefined {
  return priceFor(model)?.contextWindow;
}

export function isLongPrompt(model: string | undefined, promptTokens: number): boolean {
  return LONG_PROMPT_MODELS.has(normalizeModelId(model)) && promptTokens > LONG_PROMPT_TOKENS;
}

// Ledger bucket key: normalized model id plus `|fast` / `|long` tier markers.
export function bucketKey(model: string | undefined, opts: { fast?: boolean; long?: boolean } = {}): string {
  return `${normalizeModelId(model)}${opts.fast ? "|fast" : ""}${opts.long ? "|long" : ""}`;
}

export function parseBucketKey(key: string): { model: string; fast: boolean; long: boolean } {
  const [model, ...flags] = key.split("|");
  return { model: model || "unknown", fast: flags.includes("fast"), long: flags.includes("long") };
}

// counts: [calls, input, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking]
export type UsageCounts = number[];
export const COUNT_CALLS = 0;
export const COUNT_INPUT = 1;
export const COUNT_WRITE_5M = 2;
export const COUNT_WRITE_1H = 3;
export const COUNT_READ = 4;
export const COUNT_OUTPUT = 5;
export const COUNT_THINKING = 6;
export const COUNT_FIELDS = 7;

export interface CostBreakdown {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

// Per-class dollars for a bucket; undefined when the model has no known price.
export function costBreakdown(counts: UsageCounts, key: string): CostBreakdown | undefined {
  const { model, fast, long } = parseBucketKey(key);
  const p = PRICES[model];
  if (!p) return undefined;
  let multiplier = 1;
  if (fast && FAST_MODELS.has(model)) multiplier *= FAST_MULTIPLIER;
  if (long && LONG_PROMPT_MODELS.has(model)) multiplier *= LONG_PROMPT_MULTIPLIER;
  const rate = (tokens: number | undefined, perMillion: number) => ((tokens ?? 0) * perMillion * multiplier) / M;
  const input = rate(counts[COUNT_INPUT], p.input);
  const cacheWrite5m = rate(counts[COUNT_WRITE_5M], p.cacheWrite5m);
  const cacheWrite1h = rate(counts[COUNT_WRITE_1H], p.cacheWrite1h);
  const cacheRead = rate(counts[COUNT_READ], p.cacheRead);
  const output = rate(counts[COUNT_OUTPUT], p.output);
  return { input, cacheWrite5m, cacheWrite1h, cacheRead, output, total: input + cacheWrite5m + cacheWrite1h + cacheRead + output };
}

export function costUSD(counts: UsageCounts, key: string): number | undefined {
  return costBreakdown(counts, key)?.total;
}
