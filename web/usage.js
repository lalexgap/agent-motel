"use strict";
// Pure helpers for the token usage dashboard: formatting, range math, series and chart geometry.
window.usageDashboard = (() => {
  const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
  const OTHER_COLOR = "#9085e9";
  const UNATTRIBUTED_COLOR = "#5b5b63";
  const TOKEN_CLASSES = [
    { key: "cacheRead", label: "Cache reads", color: "#3987e5" },
    { key: "cacheWrite1h", label: "Cache writes · 1h", color: "#d95926" },
    { key: "cacheWrite5m", label: "Cache writes · 5m", color: "#c98500" },
    { key: "output", label: "Output", color: "#199e70" },
    { key: "input", label: "Uncached input", color: "#5b5b63" },
  ];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function compactTokens(n) {
    const num = Number(n) || 0;
    if (num <= 0) return "0";
    if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e7) return `${Math.round(num / 1e6)}M`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e4) return `${Math.round(num / 1e3)}k`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
    return String(Math.round(num));
  }

  function money(n) {
    const num = Number(n) || 0;
    if (num <= 0) return "$0";
    if (num >= 99.995) return "$" + Math.round(num).toLocaleString("en-US");
    return "$" + num.toFixed(2);
  }

  function formatValue(n, unit) {
    return unit === "tokens" ? compactTokens(n) : money(n);
  }

  function axisLabel(n, unit) {
    if (unit === "tokens") return compactTokens(n);
    return Number.isInteger(n) ? "$" + n.toLocaleString("en-US") : money(n);
  }

  function percent(ratio) {
    return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? "—" : `${Math.round(ratio * 100)}%`;
  }

  function amountValue(amount, unit) {
    if (!amount) return 0;
    return (unit === "tokens" ? amount.activeTokens : amount.costUSD) || 0;
  }

  function dailyValues(row, unit) {
    return (unit === "tokens" ? row?.dailyActiveTokens : row?.dailyCostUSD) || [];
  }

  function lastN(values, n) {
    return (values || []).slice(Math.max(0, (values || []).length - n));
  }

  function sumLast(values, n) {
    return lastN(values, n).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }

  // Fleet total per day, aligned with summary.days.
  function dailyTotals(summary, unit) {
    const totals = new Array(summary?.days?.length || 0).fill(0);
    for (const row of [...(summary?.agents || []), summary?.unattributed]) {
      dailyValues(row, unit).forEach((v, i) => {
        if (i < totals.length) totals[i] += Number(v) || 0;
      });
    }
    return totals;
  }

  function parseDay(day) {
    const [y, m, d] = String(day).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1, 12);
  }

  function isWeekend(day) {
    const dow = parseDay(day).getDay();
    return dow === 0 || dow === 6;
  }

  function longDay(day) {
    const date = parseDay(day);
    return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  }

  // Axis tick: month name on the first bar and on the 1st of a month, day number otherwise.
  function dayTick(day, index) {
    const date = parseDay(day);
    return index === 0 || date.getDate() === 1 ? longDay(day) : String(date.getDate());
  }

  // Top 5 agents by span total, then "Other agents (n)", then the unattributed "Not in am" series.
  function chartSeries(summary, unit, span = 14) {
    const days = lastN(summary?.days || [], span);
    const ranked = (summary?.agents || [])
      .map((agent) => {
        const values = lastN(dailyValues(agent, unit), span);
        return { agent, values, total: values.reduce((s, v) => s + (Number(v) || 0), 0) };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || a.agent.name.localeCompare(b.agent.name));
    const series = ranked.slice(0, 5).map((row, i) => ({
      key: `agent:${row.agent.name}`,
      label: row.agent.name,
      color: SERIES_COLORS[i],
      kind: "agent",
      values: row.values.map((v) => Number(v) || 0),
      total: row.total,
    }));
    const rest = ranked.slice(5);
    if (rest.length) {
      const values = new Array(days.length).fill(0);
      for (const row of rest) row.values.forEach((v, i) => (values[i] += Number(v) || 0));
      series.push({
        key: "other",
        label: `Other agents (${rest.length})`,
        color: OTHER_COLOR,
        kind: "other",
        count: rest.length,
        values,
        total: values.reduce((s, v) => s + v, 0),
      });
    }
    const unattributed = lastN(dailyValues(summary?.unattributed, unit), span).map((v) => Number(v) || 0);
    const unattributedTotal = unattributed.reduce((s, v) => s + v, 0);
    if (unattributedTotal > 0) {
      series.push({
        key: "unattributed",
        label: "Not in am",
        color: UNATTRIBUTED_COLOR,
        kind: "unattributed",
        values: unattributed,
        total: unattributedTotal,
      });
    }
    return { days, series };
  }

  function niceStep(max, steps = 4) {
    const raw = max / steps;
    if (!(raw > 0)) return 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw - 1e-9) return m * mag;
    return 10 * mag;
  }

  // Path for a bar with only its top corners rounded.
  function segmentPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, h, w / 2));
    const f = (n) => Math.round(n * 100) / 100;
    if (rr === 0) return `M${f(x)},${f(y + h)}V${f(y)}H${f(x + w)}V${f(y + h)}Z`;
    return (
      `M${f(x)},${f(y + h)}V${f(y + rr)}Q${f(x)},${f(y)} ${f(x + rr)},${f(y)}` +
      `H${f(x + w - rr)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + rr)}V${f(y + h)}Z`
    );
  }

  // Stacked bar geometry in pixels. Each segment's slot spans its value exactly; the drawn rect
  // gives up `gap` px at its top to the segment above, so totals and hit targets stay exact.
  function stackedBars(series, count, opts = {}) {
    const {
      width = 600,
      height = 280,
      top = 22,
      bottom = 24,
      left = 48,
      right = 8,
      gap = 2,
      radius = 4,
      barRatio = 0.62,
      maxBarWidth = 44,
      steps = 4,
    } = opts;
    const totals = Array.from({ length: count }, (_, i) =>
      series.reduce((sum, s) => sum + Math.max(0, Number(s.values[i]) || 0), 0),
    );
    const maxTotal = Math.max(0, ...totals);
    const step = niceStep(maxTotal, steps);
    const axisMax = step * steps;
    const plotHeight = Math.max(1, height - top - bottom);
    const baseline = top + plotHeight;
    const scale = plotHeight / axisMax;
    const slot = Math.max(0, width - left - right) / Math.max(1, count);
    const barWidth = Math.max(2, Math.min(maxBarWidth, slot * barRatio));
    const bars = totals.map((total, index) => {
      const x = left + slot * index + (slot - barWidth) / 2;
      const segments = [];
      let cum = 0;
      series.forEach((s, seriesIndex) => {
        const value = Math.max(0, Number(s.values[index]) || 0);
        if (value <= 0) return;
        const y0 = baseline - cum * scale;
        cum += value;
        const y1 = baseline - cum * scale;
        segments.push({ seriesIndex, value, slotY: y1, slotHeight: y0 - y1 });
      });
      segments.forEach((seg, i) => {
        const isTop = i === segments.length - 1;
        const shrink = isTop ? 0 : gap;
        seg.y = seg.slotY + Math.min(shrink, seg.slotHeight);
        seg.height = Math.max(0, seg.slotHeight - shrink);
        seg.top = isTop;
        seg.path = segmentPath(x, seg.y, barWidth, seg.height, isTop ? radius : 0);
      });
      return { index, x, width: barWidth, center: x + barWidth / 2, total, top: baseline - total * scale, segments };
    });
    const ticks = Array.from({ length: steps + 1 }, (_, k) => ({ value: k * step, y: baseline - k * step * scale }));
    return { width, height, left, right, baseline, slot, axisMax, ticks, bars, empty: maxTotal <= 0 };
  }

  function sparkline(values, opts = {}) {
    const { width = 86, height = 22, pad = 2.5 } = opts;
    const list = (values || []).map((v) => Math.max(0, Number(v) || 0));
    const max = Math.max(0, ...list);
    const n = list.length;
    const xs = (i) => (n <= 1 ? width / 2 : pad + ((width - 2 * pad) * i) / (n - 1));
    const ys = (v) => (max > 0 ? height - pad - ((height - 2 * pad) * v) / max : height - pad);
    const coords = list.map((v, i) => [Math.round(xs(i) * 10) / 10, Math.round(ys(v) * 10) / 10]);
    return {
      points: coords.map(([x, y]) => `${x},${y}`).join(" "),
      last: coords.length ? { x: coords[coords.length - 1][0], y: coords[coords.length - 1][1] } : null,
      max,
    };
  }

  function tokenClasses(summary, unit) {
    const classes = summary?.classes || {};
    const rows = TOKEN_CLASSES.map((c) => ({
      ...c,
      value: (unit === "tokens" ? classes[c.key]?.tokens : classes[c.key]?.costUSD) || 0,
    }));
    const total = rows.reduce((sum, r) => sum + r.value, 0);
    return { total, rows: rows.map((r) => ({ ...r, share: total > 0 ? r.value / total : 0 })) };
  }

  // Cache re-writes: write cost as a share of all spend; in tokens mode, writes vs reads.
  function cacheRewrites(summary, unit) {
    const c = summary?.classes || {};
    if (unit === "tokens") {
      const writes = (c.cacheWrite1h?.tokens || 0) + (c.cacheWrite5m?.tokens || 0);
      const reads = c.cacheRead?.tokens || 0;
      return { ratio: writes + reads > 0 ? writes / (writes + reads) : null, writes, reads };
    }
    const writes = (c.cacheWrite1h?.costUSD || 0) + (c.cacheWrite5m?.costUSD || 0);
    const reads = c.cacheRead?.costUSD || 0;
    const total = TOKEN_CLASSES.reduce((sum, k) => sum + (c[k.key]?.costUSD || 0), 0);
    return { ratio: total > 0 ? writes / total : null, writes, reads };
  }

  function kpis(summary, unit) {
    const totals = summary?.totals || {};
    const today = amountValue(totals.today, unit);
    const last7 = amountValue(totals.last7, unit);
    const last30 = amountValue(totals.last30, unit);
    const avg7 = last7 / 7;
    const days = summary?.days || [];
    const perDay = dailyTotals(summary, unit);
    let peak = null;
    for (let i = Math.max(0, days.length - 7); i < days.length; i++) {
      if (perDay[i] > 0 && (!peak || perDay[i] > peak.value)) peak = { day: days[i], value: perDay[i] };
    }
    const agents = summary?.agents || [];
    let detached = sumLast(dailyValues(summary?.unattributed, unit), 30);
    for (const agent of agents) if (agent.status === "removed") detached += sumLast(dailyValues(agent, unit), 30);
    return {
      today,
      activeToday: agents.filter((a) => (a.today?.calls || 0) > 0).length,
      todayVsAverage: avg7 > 0 ? (today - avg7) / avg7 : null,
      last7,
      averagePerDay: avg7,
      peak,
      last30,
      detached,
      cache: cacheRewrites(summary, unit),
    };
  }

  function topAgents(summary, unit) {
    return (summary?.agents || [])
      .filter((a) => (a.range?.calls || 0) > 0 || amountValue(a.range, unit) > 0)
      .sort(
        (a, b) =>
          amountValue(b.range, unit) - amountValue(a.range, unit) ||
          (b.range?.activeTokens || 0) - (a.range?.activeTokens || 0) ||
          a.name.localeCompare(b.name),
      );
  }

  // Dollar cells for spend that has no price (e.g. Codex) fall back to tokens.
  function amountLabel(amount, unit) {
    if (unit !== "tokens" && !(amount?.costUSD > 0) && (amount?.unpricedActiveTokens || 0) > 0) {
      return { text: `${compactTokens(amount.unpricedActiveTokens)} tok`, unpriced: true };
    }
    return { text: formatValue(amountValue(amount, unit), unit), unpriced: false };
  }

  function severity(value, warn, danger) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "";
    return value >= danger ? "danger" : value >= warn ? "warn" : "";
  }

  function shortModel(model) {
    return String(model || "").replace(/^claude-/, "");
  }

  return {
    SERIES_COLORS,
    OTHER_COLOR,
    UNATTRIBUTED_COLOR,
    TOKEN_CLASSES,
    compactTokens,
    money,
    formatValue,
    axisLabel,
    percent,
    amountValue,
    amountLabel,
    dailyValues,
    dailyTotals,
    lastN,
    sumLast,
    isWeekend,
    longDay,
    dayTick,
    chartSeries,
    niceStep,
    segmentPath,
    stackedBars,
    sparkline,
    tokenClasses,
    cacheRewrites,
    kpis,
    topAgents,
    severity,
    shortModel,
  };
})();
