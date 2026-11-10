import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function load() {
  const window: any = {};
  runInNewContext(readFileSync(new URL("../web/usage.js", import.meta.url), "utf8"), { window });
  return window.usageDashboard;
}

const U = load();
const DAYS = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

function amount(costUSD = 0, activeTokens = 0, extra: Record<string, number> = {}) {
  return { costUSD, activeTokens, cacheReadTokens: 0, unpricedActiveTokens: 0, calls: costUSD || activeTokens ? 1 : 0, ...extra };
}

function agent(name: string, daily: number[], extra: Record<string, unknown> = {}) {
  const dailyCostUSD = new Array(30 - daily.length).fill(0).concat(daily);
  const range = dailyCostUSD.slice(-7).reduce((a, b) => a + b, 0);
  return {
    name,
    provider: "claude",
    status: "idle",
    live: true,
    range: amount(range, range * 1000),
    today: amount(dailyCostUSD[29], dailyCostUSD[29] * 1000),
    mainCostUSD: range,
    subagentCostUSD: 0,
    subagents: 0,
    cacheWriteShare: null,
    cacheHitRate: null,
    context: null,
    dailyCostUSD,
    dailyActiveTokens: dailyCostUSD.map((v) => v * 1000),
    ...extra,
  };
}

function summary(agents: any[], unattributed: number[] = []) {
  const dailyCostUSD = new Array(30 - unattributed.length).fill(0).concat(unattributed);
  return {
    days: DAYS,
    totals: { today: amount(), last7: amount(), last30: amount() },
    classes: {
      cacheRead: { costUSD: 0, tokens: 0 },
      cacheWrite1h: { costUSD: 0, tokens: 0 },
      cacheWrite5m: { costUSD: 0, tokens: 0 },
      output: { costUSD: 0, tokens: 0 },
      input: { costUSD: 0, tokens: 0 },
    },
    byModel: [],
    byRepo: [],
    agents,
    unattributed: { dailyCostUSD, dailyActiveTokens: dailyCostUSD.map((v) => v * 1000), range: amount() },
    filters: { repos: [], providers: [] },
  };
}

describe("formatting", () => {
  test("money drops cents from $100 up and keeps them below", () => {
    expect(U.money(1828.4)).toBe("$1,828");
    expect(U.money(100)).toBe("$100");
    expect(U.money(99.999)).toBe("$100");
    expect(U.money(57.724)).toBe("$57.72");
    expect(U.money(0.004)).toBe("$0.00");
    expect(U.money(0)).toBe("$0");
    expect(U.money(undefined)).toBe("$0");
  });

  test("tokens use the compact token format; unit selects the formatter", () => {
    expect(U.compactTokens(0)).toBe("0");
    expect(U.compactTokens(1234)).toBe("1.2k");
    expect(U.compactTokens(27_000_000)).toBe("27M");
    expect(U.compactTokens(5_484_760_725)).toBe("5.5B");
    expect(U.formatValue(1500, "tokens")).toBe("1.5k");
    expect(U.formatValue(1500, "usd")).toBe("$1,500");
  });

  test("percent and axis labels", () => {
    expect(U.percent(0.384)).toBe("38%");
    expect(U.percent(null)).toBe("—");
    expect(U.axisLabel(1500, "usd")).toBe("$1,500");
    expect(U.axisLabel(2.5, "usd")).toBe("$2.50");
    expect(U.axisLabel(50_000_000, "tokens")).toBe("50M");
  });

  test("day ticks name the month on the first bar and on the 1st", () => {
    expect(U.dayTick("2026-10-28", 0)).toBe("Oct 28");
    expect(U.dayTick("2026-10-29", 1)).toBe("29");
    expect(U.dayTick("2026-11-01", 4)).toBe("Nov 1");
    expect(U.isWeekend("2026-11-07")).toBe(true);
    expect(U.isWeekend("2026-11-09")).toBe(false);
  });
});

describe("range math", () => {
  test("sums the trailing window and builds per-day fleet totals", () => {
    expect(U.sumLast([1, 2, 3, 4], 2)).toBe(7);
    expect(U.sumLast([1, 2], 7)).toBe(3);
    const s = summary([agent("a", [1, 2]), agent("b", [0, 3])], [5]);
    const totals = U.dailyTotals(s, "usd");
    expect(totals.length).toBe(30);
    expect(totals.slice(-2)).toEqual([1, 10]);
  });

  test("KPIs: today vs 7-day average, peak day, and spend not tied to a current agent", () => {
    const s = summary(
      [agent("live", [10, 20, 30]), agent("gone", [40, 0, 0], { status: "removed" })],
      new Array(30).fill(1),
    );
    s.totals = { today: amount(31, 31_000), last7: amount(140, 140_000), last30: amount(500, 500_000) };
    const k = U.kpis(s, "usd");
    expect(k.today).toBe(31);
    expect(k.averagePerDay).toBe(20);
    expect(k.todayVsAverage).toBeCloseTo(0.55);
    expect(k.peak).toEqual({ day: "2026-10-28", value: 51 });
    expect(k.detached).toBe(30 + 40);
    expect(k.activeToday).toBe(1);
    const t = U.kpis(s, "tokens");
    expect(t.today).toBe(31_000);
    expect(t.detached).toBe(70_000);
  });

  test("KPIs with no spend have no ratio to report", () => {
    const k = U.kpis(summary([]), "usd");
    expect(k.todayVsAverage).toBeNull();
    expect(k.peak).toBeNull();
    expect(k.cache.ratio).toBeNull();
  });
});

describe("cache re-writes and token classes", () => {
  const s = summary([]);
  s.classes = {
    cacheRead: { costUSD: 40, tokens: 9_000 },
    cacheWrite1h: { costUSD: 20, tokens: 600 },
    cacheWrite5m: { costUSD: 20, tokens: 400 },
    output: { costUSD: 20, tokens: 100 },
    input: { costUSD: 0, tokens: 50 },
  };

  test("dollars: writes as a share of all spend", () => {
    expect(U.cacheRewrites(s, "usd")).toEqual({ ratio: 0.4, writes: 40, reads: 40 });
  });

  test("tokens: writes against reads", () => {
    expect(U.cacheRewrites(s, "tokens")).toEqual({ ratio: 0.1, writes: 1000, reads: 9000 });
  });

  test("token classes keep a fixed order and share", () => {
    const { total, rows } = U.tokenClasses(s, "usd");
    expect(total).toBe(100);
    expect(rows.map((r: any) => r.key)).toEqual(["cacheRead", "cacheWrite1h", "cacheWrite5m", "output", "input"]);
    expect(rows.map((r: any) => r.color)).toEqual(["#3987e5", "#d95926", "#c98500", "#199e70", "#5b5b63"]);
    expect(rows[0].share).toBe(0.4);
    expect(U.tokenClasses(s, "tokens").rows[0].value).toBe(9000);
  });
});

describe("chart series", () => {
  test("top five by 14-day total, then Other (n), then Not in am, in fixed colors", () => {
    const agents = ["a", "b", "c", "d", "e", "f", "g"].map((name, i) => agent(name, [7 - i]));
    agents.push(agent("old", [], { dailyCostUSD: new Array(30).fill(0).map((_, i) => (i === 0 ? 99 : 0)) }));
    const { days, series } = U.chartSeries(summary(agents, [2]), "usd");
    expect(days).toEqual(DAYS.slice(-14));
    expect(series.map((s: any) => s.label)).toEqual(["a", "b", "c", "d", "e", "Other agents (2)", "Not in am"]);
    expect(series.map((s: any) => s.color)).toEqual([...U.SERIES_COLORS, U.OTHER_COLOR, U.UNATTRIBUTED_COLOR]);
    expect(series[5].values[13]).toBe(2 + 1);
    expect(series[6].values[13]).toBe(2);
  });

  test("ties break by name and fewer than five agents need no Other series", () => {
    const { series } = U.chartSeries(summary([agent("zed", [5]), agent("amy", [5]), agent("idle", [0])]), "usd");
    expect(series.map((s: any) => s.label)).toEqual(["amy", "zed"]);
  });

  test("all-zero days produce no series; unattributed alone is one series", () => {
    expect(U.chartSeries(summary([agent("a", [0, 0])]), "usd").series).toEqual([]);
    const only = U.chartSeries(summary([], [0, 3]), "usd").series;
    expect(only.map((s: any) => s.kind)).toEqual(["unattributed"]);
  });

  test("tokens mode ranks by active tokens, so unpriced agents can lead", () => {
    const codex = agent("codex", [0], { dailyActiveTokens: new Array(29).fill(0).concat([5_000_000]) });
    const s = summary([agent("claude", [1]), codex]);
    expect(U.chartSeries(s, "usd").series.map((x: any) => x.label)).toEqual(["claude"]);
    expect(U.chartSeries(s, "tokens").series.map((x: any) => x.label)).toEqual(["codex", "claude"]);
  });
});

describe("stacked bar geometry", () => {
  const series = [
    { values: [10, 0, 0.01, 5] },
    { values: [30, 0, 0.01, 0] },
    { values: [60, 0, 100, 5] },
  ];
  const geo = U.stackedBars(series, 4, { width: 400, height: 240, gap: 2, radius: 4 });

  test("segment gaps never produce negative heights and slots tile the bar exactly", () => {
    for (const bar of geo.bars) {
      let bottom = geo.baseline;
      for (const seg of bar.segments) {
        expect(seg.height).toBeGreaterThanOrEqual(0);
        expect(seg.y + seg.height).toBeCloseTo(bottom, 6);
        bottom = seg.slotY;
      }
      if (bar.segments.length) expect(bottom).toBeCloseTo(bar.top, 6);
    }
  });

  test("totals match values, empty days have no segments, and only the top segment is rounded", () => {
    expect(geo.bars.map((b: any) => b.total)).toEqual([100, 0, 100.02, 10]);
    expect(geo.bars[1].segments).toEqual([]);
    const first = geo.bars[0].segments;
    expect(first.map((s: any) => s.top)).toEqual([false, false, true]);
    expect(first[2].path).toContain("Q");
    expect(first[0].path).not.toContain("Q");
    expect(first[0].height).toBeCloseTo(first[0].slotHeight - 2, 6);
    expect(first[2].height).toBeCloseTo(first[2].slotHeight, 6);
  });

  test("the axis has four nice steps covering the tallest bar", () => {
    expect(geo.ticks.length).toBe(5);
    expect(geo.axisMax).toBeGreaterThanOrEqual(100.02);
    expect(geo.ticks[0].y).toBe(geo.baseline);
    expect(U.niceStep(1288, 4)).toBe(500);
    expect(U.niceStep(0, 4)).toBe(1);
  });

  test("an all-zero chart is flagged empty", () => {
    expect(U.stackedBars([{ values: [0, 0] }], 2).empty).toBe(true);
  });

  test("top-rounded path clamps its radius to tiny segments", () => {
    expect(U.segmentPath(0, 10, 20, 1, 4)).toBe("M0,11V11Q0,10 1,10H19Q20,10 20,11V11Z");
    expect(U.segmentPath(0, 10, 20, 0, 4)).toBe("M0,10V10H20V10Z");
  });
});

describe("table helpers", () => {
  test("sparkline spans the box and pins zeros to the bottom", () => {
    const flat = U.sparkline([0, 0, 0], { width: 86, height: 22, pad: 2 });
    expect(flat.points).toBe("2,20 43,20 84,20");
    const peak = U.sparkline([0, 4, 2], { width: 86, height: 22, pad: 2 });
    expect(peak.points).toBe("2,20 43,2 84,11");
    expect(peak.last).toEqual({ x: 84, y: 11 });
  });

  test("top agents sort by the selected unit and skip agents idle in the range", () => {
    const codex = agent("codex", [0], {
      range: amount(0, 9_000_000, { unpricedActiveTokens: 9_000_000, calls: 3 }),
    });
    const idle = agent("idle", [0], { range: amount() });
    const s = summary([agent("b", [2]), agent("a", [5]), codex, idle]);
    expect(U.topAgents(s, "usd").map((a: any) => a.name)).toEqual(["a", "b", "codex"]);
    expect(U.topAgents(s, "tokens").map((a: any) => a.name)).toEqual(["codex", "a", "b"]);
  });

  test("unpriced dollar amounts fall back to tokens", () => {
    expect(U.amountLabel(amount(0, 5_000, { unpricedActiveTokens: 5_000 }), "usd")).toEqual({ text: "5.0k tok", unpriced: true });
    expect(U.amountLabel(amount(12.5, 5_000), "usd")).toEqual({ text: "$12.50", unpriced: false });
    expect(U.amountLabel(amount(0, 5_000, { unpricedActiveTokens: 5_000 }), "tokens")).toEqual({ text: "5.0k", unpriced: false });
  });

  test("severity thresholds and model names", () => {
    expect(U.severity(0.44, 0.45, 0.6)).toBe("");
    expect(U.severity(0.45, 0.45, 0.6)).toBe("warn");
    expect(U.severity(0.6, 0.45, 0.6)).toBe("danger");
    expect(U.severity(null, 60, 80)).toBe("");
    expect(U.shortModel("claude-opus-5-5")).toBe("opus-5-5");
    expect(U.shortModel("gpt-6-astra")).toBe("gpt-6-astra");
  });
});

test("the page loads usage.js before app.js, the server serves it, and the stale eyebrows are gone", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  expect(html.indexOf('<script src="/usage.js" defer></script>')).toBeGreaterThan(-1);
  expect(html.indexOf("/usage.js")).toBeLessThan(html.indexOf("/app.js"));
  expect(server).toContain('"/usage.js": "web/usage.js"');
  expect(html).not.toMatch(/OPTION \d/);
  expect(html).toMatch(/<details id="usage-breakdown"/);
});
