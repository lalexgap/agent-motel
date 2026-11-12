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

  function formatResetCountdown(iso) {
    if (!iso) return "";
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return "resets soon";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `resets in ${hours}h ${mins % 60}m`;
    return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  // Shared by the browser UI and the desktop app. Renderers fill the skeleton that
  // buildPage creates (index.html carries the same markup) inside `root`, from data
  // passed in; they make no network calls. User actions go to the host through
  // `actions`:
  //   statusDot(status) -> Node          agent status dot
  //   setRange(days), setUnit(unit)      toolbar segmented controls
  //   changeSummaryFilter(), refreshSummary()
  //   breakdownToggled(open), changeBreakdownFilter(), refreshBreakdown()
  //   openBreakdown(agentName), toggleAllAgents(), toggleSubagents(agentName)
  //   openAgent(name), openSubagent(agentName, id, label, statusLabel)
  //   chartResized()                     the chart's width changed since it was drawn
  const RANGE_LABEL = { 1: "today", 7: "last 7 days", 30: "last 30 days" };
  const RANGE_SPEND = { 1: "Today's spend", 7: "7-day spend", 30: "30-day spend" };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const chartWidths = new WeakMap();
  const find = (root, id) => root.querySelector("#" + id);

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  };

  // Mirrors index.html's #usage-page so a host without that page gets the same markup.
  function buildPage(root) {
    const h = (tag, attrs, ...children) => {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
      node.append(...children);
      return node;
    };
    const header = (title, note) => h("div", { class: "usage-card-header" }, title, note);
    const titled = (eyebrow, id, text) => h("div", null, h("p", { class: "usage-eyebrow" }, eyebrow), h("h2", { id }, text));
    const rangeNote = () => h("small", { class: "muted usage-range-note" });
    const select = (id, ...options) => h("select", { id }, ...options.map(([value, text]) => h("option", { value }, text)));
    root.append(
      h("div", { class: "usage-toolbar" },
        h("div", { class: "usage-filters" },
          h("div", { class: "usage-segmented", id: "usage-range", role: "group", "aria-label": "Range" },
            h("button", { type: "button", "data-range": "1" }, "Today"),
            h("button", { type: "button", "data-range": "7", "aria-pressed": "true" }, "7 days"),
            h("button", { type: "button", "data-range": "30" }, "30 days")),
          h("label", null, "Repo", select("usage-repo", ["", "All"])),
          h("label", null, "Provider", select("usage-summary-provider", ["", "All"])),
          h("div", { class: "usage-segmented", id: "usage-unit", role: "group", "aria-label": "Unit" },
            h("button", { type: "button", "data-unit": "usd", "aria-pressed": "true" }, "$"),
            h("button", { type: "button", "data-unit": "tokens" }, "Tokens")),
          h("button", { id: "usage-refresh", type: "button" }, "Refresh")),
        h("span", { id: "usage-status", class: "muted", role: "status" })),
      h("div", { id: "usage-quota", class: "usage-quota-grid", "aria-label": "Provider rate limit headroom" }),
      h("div", { id: "usage-dash-kpis", class: "usage-dash-kpis", "aria-label": "Spend summary" }),
      h("div", { class: "usage-dash-row" },
        h("section", { class: "usage-card", "aria-labelledby": "usage-chart-heading" },
          header(titled("Spend per day", "usage-chart-heading", "Daily spend by agent · last 14 days"), h("small", { class: "muted", id: "usage-chart-unit" })),
          h("div", { id: "usage-chart-legend", class: "usage-legend" }),
          h("div", { id: "usage-chart", class: "usage-chart" })),
        h("div", { class: "usage-dash-side" },
          h("section", { class: "usage-card", "aria-labelledby": "usage-classes-heading" },
            header(titled("Where the money goes", "usage-classes-heading", "Spend by token class"), rangeNote()),
            h("div", { id: "usage-classes" })),
          h("section", { class: "usage-card", "aria-labelledby": "usage-models-heading" },
            header(h("h2", { id: "usage-models-heading" }, "By model"), rangeNote()),
            h("div", { id: "usage-models" })),
          h("section", { class: "usage-card", "aria-labelledby": "usage-types-heading" },
            header(h("h2", { id: "usage-types-heading" }, "By agent type"), rangeNote()),
            h("div", { id: "usage-types" })),
          h("section", { class: "usage-card", "aria-labelledby": "usage-efforts-heading" },
            header(h("h2", { id: "usage-efforts-heading" }, "By effort"), rangeNote()),
            h("div", { id: "usage-efforts" })),
          h("section", { class: "usage-card", "aria-labelledby": "usage-repos-heading" },
            header(h("h2", { id: "usage-repos-heading" }, "By repo"), rangeNote()),
            h("div", { id: "usage-repos" })))),
      h("section", { class: "usage-card", "aria-labelledby": "usage-top-heading" },
        header(titled("Who is spending", "usage-top-heading", "Top agents"), h("small", { class: "muted" }, "Click an agent for its detailed breakdown")),
        h("div", { id: "usage-top-agents", class: "usage-table-wrap" })),
      h("details", { id: "usage-breakdown", class: "usage-breakdown" },
        h("summary", null,
          h("span", { class: "usage-breakdown-title" }, "Detailed breakdown"),
          h("small", { class: "muted" }, "Agents, subagents, workflows, tools and anomalies · scans transcripts on open")),
        h("div", { class: "usage-breakdown-body" },
          h("div", { class: "usage-toolbar" },
            h("div", { class: "usage-filters" },
              h("label", null, "Scope", select("usage-agent", ["", "All local agents"])),
              h("label", null, "Provider", select("usage-provider", ["", "All providers"], ["codex", "Codex"], ["claude", "Claude"], ["antigravity", "Antigravity"])),
              h("button", { id: "usage-breakdown-refresh", type: "button" }, "Refresh"),
              h("button", { id: "usage-clear-agent", type: "button", hidden: "" }, "All agents")),
            h("span", { id: "usage-breakdown-status", class: "muted", role: "status" })),
          h("div", { id: "usage-kpis", class: "usage-kpi-grid", "aria-label": "Token summary metrics" }),
          h("div", { class: "usage-grid" },
            h("section", { class: "usage-card usage-span-full", "aria-labelledby": "usage-agents-heading" },
              header(h("h2", { id: "usage-agents-heading" }, "By agent, subagent & role"),
                h("small", { class: "muted" }, "Ranked by quota weight (1× new input · 1.25× cache write · 0.1× cache read · 5× output)")),
              h("div", { id: "usage-roles", class: "usage-role-pills" }),
              h("div", { id: "usage-agents", class: "usage-table-wrap" })),
            h("section", { class: "usage-card", "aria-labelledby": "usage-workflows-heading" },
              header(h("h2", { id: "usage-workflows-heading" }, "By workflow / skill"),
                h("small", { class: "muted" }, "Attributed from skill preambles, prompts & tool calls")),
              h("div", { id: "usage-workflows", class: "usage-table-wrap" })),
            h("section", { class: "usage-card", "aria-labelledby": "usage-tools-heading" },
              header(h("h2", { id: "usage-tools-heading" }, "By tool & command category"),
                h("small", { class: "muted" }, "Includes dev-server (stack.sh), verify-ui, git, CI, tests & MCP")),
              h("div", { id: "usage-tools", class: "usage-table-wrap" })),
            h("section", { class: "usage-card usage-span-full", "aria-labelledby": "usage-anomalies-heading" },
              header(h("h2", { id: "usage-anomalies-heading" }, "Top budget offenders & anomalies"),
                h("small", { class: "muted" }, "Cache-bust pauses (>5m idle), bloated tool outputs, high-step polling loops & subagent cold-start tax")),
              h("div", { id: "usage-anomalies", class: "usage-anomaly-list" }))))),
      h("div", { id: "usage-tooltip", class: "usage-tooltip", role: "tooltip", hidden: "" }),
    );
    return root;
  }

  function bindControls(root, actions) {
    find(root, "usage-range").onclick = (event) => {
      const button = event.target.closest("button[data-range]");
      if (button) actions.setRange(Number(button.dataset.range));
    };
    find(root, "usage-unit").onclick = (event) => {
      const button = event.target.closest("button[data-unit]");
      if (button) actions.setUnit(button.dataset.unit);
    };
    find(root, "usage-repo").onchange = () => actions.changeSummaryFilter();
    find(root, "usage-summary-provider").onchange = () => actions.changeSummaryFilter();
    find(root, "usage-refresh").onclick = () => actions.refreshSummary();
    const breakdown = find(root, "usage-breakdown");
    breakdown.addEventListener("toggle", () => actions.breakdownToggled(breakdown.open));
    find(root, "usage-agent").onchange = () => actions.changeBreakdownFilter();
    find(root, "usage-provider").onchange = () => actions.changeBreakdownFilter();
    find(root, "usage-breakdown-refresh").onclick = () => actions.refreshBreakdown();
    find(root, "usage-clear-agent").onclick = () => filterAgent(root, "", actions);
    const chart = find(root, "usage-chart");
    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = chart.clientWidth;
        if (width > 0 && Math.abs(width - (chartWidths.get(root) || 0)) > 1) actions.chartResized();
      });
    }).observe(chart);
  }

  function filterAgent(root, name, actions) {
    find(root, "usage-agent").value = name;
    actions.changeBreakdownFilter();
  }

  function usageSwatch(color) {
    const node = el("i", "usage-swatch");
    node.style.background = color;
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function usageEmpty(text = "No usage recorded in this range.") {
    return el("p", "empty usage-empty", text);
  }

  function showTooltip(root, event, lines) {
    const tip = find(root, "usage-tooltip");
    tip.replaceChildren(...lines.map((line, i) => el(i === 0 ? "strong" : "span", "", line)));
    tip.hidden = false;
    const pad = 12;
    const { offsetWidth: w, offsetHeight: h } = tip;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + w > window.innerWidth - 4) x = event.clientX - w - pad;
    if (y + h > window.innerHeight - 4) y = event.clientY - h - pad;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }

  function bindTooltip(root, node, lines) {
    node.addEventListener("pointerenter", (event) => showTooltip(root, event, lines));
    node.addEventListener("pointermove", (event) => showTooltip(root, event, lines));
    node.addEventListener("pointerleave", () => { find(root, "usage-tooltip").hidden = true; });
  }

  function usageMeter(pct, severity = "") {
    const track = el("div", "usage-bar-track");
    const fill = el("div", "usage-bar-fill" + (severity ? ` ${severity}` : ""));
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    track.append(fill);
    return track;
  }

  function populateFilter(select, values, label = (v) => v) {
    const previous = select.value;
    const list = [...values];
    if (previous && !list.includes(previous)) list.unshift(previous);
    const sig = JSON.stringify(list);
    if (select.dataset.options !== sig) {
      select.replaceChildren(new Option("All", ""), ...list.map((v) => new Option(label(v), v)));
      select.dataset.options = sig;
    }
    select.value = previous;
  }

  function populateAgentSelect(root, fleetNames, reportAgents = []) {
    const select = find(root, "usage-agent");
    if (!select) return;
    const previous = select.value;
    const names = new Set(fleetNames);
    for (const a of reportAgents) {
      if (a?.name) names.add(a.name);
    }
    const sorted = [...names].sort();
    if (previous && !sorted.includes(previous)) sorted.unshift(previous);
    const sig = JSON.stringify(sorted);
    if (select.dataset.options !== sig) {
      select.replaceChildren(
        new Option("All local agents", ""),
        ...sorted.map((name) => new Option(name, name)),
      );
      select.dataset.options = sig;
    }
    select.value = previous;
    find(root, "usage-clear-agent").hidden = !select.value;
  }

  function renderQuota(root, quotaList) {
    const wrap = find(root, "usage-quota");
    wrap.replaceChildren();
    if (!Array.isArray(quotaList) || !quotaList.length) return;
    for (const item of quotaList) {
      const card = el("div", "usage-quota-card");
      const head = el("div", "usage-quota-head");
      const title = el("strong", "", item.provider === "codex" ? "Codex quota" : "Claude quota");
      const plan = el("span", "usage-pill", item.plan || item.status);
      head.append(title, plan);
      card.append(head);
      if (item.error && (!item.windows || !item.windows.length)) {
        card.append(el("p", "muted", item.error));
      } else {
        for (const win of item.windows || []) {
          const pct = Math.max(0, Math.min(100, Math.round(win.utilization || 0)));
          const row = el("div", "usage-window-row");
          const meta = el("div", "usage-window-meta");
          meta.append(
            el("span", "mono", `${win.label} · ${pct}% used`),
            el("small", "muted", formatResetCountdown(win.resetsAt)),
          );
          const track = el("div", "usage-bar-track");
          const fill = el("div", "usage-bar-fill" + (pct >= 90 ? " danger" : pct >= 75 ? " warn" : ""));
          fill.style.width = `${pct}%`;
          track.append(fill);
          row.append(meta, track);
          card.append(row);
        }
      }
      wrap.append(card);
    }
  }

  // view: { summary, range, unit, showAllAgents }
  function renderDashboard(root, view, actions) {
    const summary = view.summary;
    if (!summary) return;
    const unit = view.unit;
    populateFilter(find(root, "usage-repo"), summary.filters?.repos || [], (r) => (r === "~" ? "~ (home)" : r));
    populateFilter(find(root, "usage-summary-provider"), summary.filters?.providers || [], (p) => p[0].toUpperCase() + p.slice(1));
    for (const button of find(root, "usage-range").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.range) === view.range));
    }
    for (const button of find(root, "usage-unit").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.unit === unit));
    }
    const rangeLabel = RANGE_LABEL[view.range];
    root.querySelectorAll(".usage-range-note").forEach((node) => (node.textContent = rangeLabel));
    find(root, "usage-chart-unit").textContent = unit === "tokens" ? "Active tokens" : "API-equivalent $";
    find(root, "usage-chart-heading").textContent = `Daily ${unit === "tokens" ? "tokens" : "spend"} by agent · last 14 days`;
    find(root, "usage-classes-heading").textContent = unit === "tokens" ? "Tokens by class" : "Spend by token class";

    renderKpis(root, summary, unit, view.range);
    renderClasses(root, summary, unit);
    renderModels(root, summary, unit);
    renderTypes(root, summary, unit);
    renderEfforts(root, summary, unit);
    renderRepos(root, summary, unit);
    renderChart(root, view);
    renderTopAgents(root, view, actions);
  }

  function renderKpis(root, summary, unit, range) {
    const k = kpis(summary, unit);
    const fmt = (n) => formatValue(n, unit);
    const wrap = find(root, "usage-dash-kpis");
    wrap.replaceChildren();
    const tile = (label, value, ...sub) => {
      const card = el("div", "usage-kpi-card usage-dash-kpi");
      const valueNode = el("strong", "usage-kpi-value");
      valueNode.append(...[].concat(value));
      const subNode = el("small", "muted");
      subNode.append(...sub);
      card.append(el("span", "usage-kpi-label", label), valueNode, subNode);
      wrap.append(card);
    };
    const delta = [];
    if (k.todayVsAverage !== null) {
      const up = k.todayVsAverage >= 0;
      delta.push(
        " · ",
        el("span", up ? "usage-delta up" : "usage-delta down", `${up ? "▲" : "▼"} ${Math.abs(Math.round(k.todayVsAverage * 100))}%`),
        " vs 7-day daily avg",
      );
    }
    tile("Today", fmt(k.today), `${k.activeToday} agent${k.activeToday === 1 ? "" : "s"} active`, ...delta);
    tile(
      "Last 7 days",
      fmt(k.last7),
      `${fmt(k.averagePerDay)} / day` + (k.peak ? ` · peak ${fmt(k.peak.value)} on ${longDay(k.peak.day)}` : ""),
    );
    tile(
      "Last 30 days",
      fmt(k.last30),
      k.detached > 0 ? `${fmt(k.detached)} not tied to a current agent` : "All tied to current agents",
    );
    const cache = k.cache;
    tile(
      "Cache re-writes",
      [percent(cache.ratio), el("small", "usage-kpi-unit", unit === "tokens" ? "of cache tokens" : "of spend")],
      unit === "tokens"
        ? `${compactTokens(cache.writes)} written vs ${compactTokens(cache.reads)} read · ${RANGE_LABEL[range]}`
        : `${money(cache.writes)} writing vs ${money(cache.reads)} reading · ${RANGE_LABEL[range]}`,
    );
  }

  function renderChart(root, view) {
    const summary = view.summary;
    const wrap = find(root, "usage-chart");
    const legend = find(root, "usage-chart-legend");
    if (!summary || !wrap) return;
    const unit = view.unit;
    const { days, series } = chartSeries(summary, unit, 14);
    legend.replaceChildren();
    wrap.replaceChildren();
    if (!series.length) {
      wrap.append(usageEmpty("No usage recorded in the last 14 days."));
      return;
    }
    for (const s of series) {
      const item = el("span", "usage-legend-item");
      item.append(usageSwatch(s.color), el("span", "", s.label));
      legend.append(item);
    }
    chartWidths.set(root, wrap.clientWidth);
    const width = Math.max(240, wrap.clientWidth || 0);
    const narrow = width < 520;
    let height = narrow ? 230 : 300;
    // Beside the right column, grow the plot to the column's height.
    const card = wrap.closest(".usage-card");
    const side = root.querySelector(".usage-dash-side");
    if (card && side && side.offsetLeft > card.offsetLeft + card.offsetWidth - 1) {
      const overhead = wrap.getBoundingClientRect().top - card.getBoundingClientRect().top + 17;
      // The side column stretches to the row, so measure its content, not its box.
      const last = side.lastElementChild;
      const sideHeight = last ? last.getBoundingClientRect().bottom - side.getBoundingClientRect().top : 0;
      height = Math.max(height, Math.min(600, Math.floor(sideHeight - overhead)));
    }
    const geo = stackedBars(series, days.length, { width, height, left: narrow ? 40 : 48, top: narrow ? 10 : 22 });
    const svg = svgEl("svg", {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `Daily ${unit === "tokens" ? "active tokens" : "API-equivalent spend"} by agent, last 14 days`,
    });
    for (const tick of geo.ticks) {
      svg.append(svgEl("line", { x1: geo.left, x2: width - geo.right, y1: tick.y, y2: tick.y, class: "usage-grid-line" }));
      const label = svgEl("text", { x: geo.left - 8, y: tick.y + 4, "text-anchor": "end", class: "usage-axis-label" });
      label.textContent = axisLabel(tick.value, unit);
      svg.append(label);
    }
    const showTotals = geo.slot >= 40;
    const labelEvery = geo.slot >= 30 ? 1 : 2;
    let labelled = 0;
    for (const bar of geo.bars) {
      const day = days[bar.index];
      for (const seg of bar.segments) {
        const s = series[seg.seriesIndex];
        if (seg.height > 0) svg.append(svgEl("path", { d: seg.path, fill: s.color }));
        const hit = svgEl("rect", {
          x: bar.x,
          y: seg.slotY,
          width: bar.width,
          height: Math.max(seg.slotHeight, 1),
          class: "usage-hit",
        });
        bindTooltip(root, hit, [s.label, `${longDay(day)} · ${formatValue(seg.value, unit)}`]);
        svg.append(hit);
      }
      if (showTotals && bar.total > 0) {
        const total = svgEl("text", { x: bar.center, y: bar.top - 6, "text-anchor": "middle", class: "usage-bar-total" });
        total.textContent = formatValue(bar.total, unit);
        svg.append(total);
      }
      if (bar.index % labelEvery === (days.length - 1) % labelEvery) {
        const tick = svgEl("text", {
          x: bar.center,
          y: geo.baseline + 16,
          "text-anchor": "middle",
          class: "usage-axis-label" + (isWeekend(day) ? " weekend" : ""),
        });
        tick.textContent = dayTick(day, labelled++);
        svg.append(tick);
      }
    }
    svg.append(svgEl("line", { x1: geo.left, x2: width - geo.right, y1: geo.baseline, y2: geo.baseline, class: "usage-axis-line" }));
    wrap.append(svg);
  }

  function renderClasses(root, summary, unit) {
    const wrap = find(root, "usage-classes");
    wrap.replaceChildren();
    const { total, rows } = tokenClasses(summary, unit);
    if (!(total > 0)) {
      wrap.append(usageEmpty());
      return;
    }
    const bar = el("div", "usage-class-bar");
    const list = el("div", "usage-class-list");
    for (const row of rows) {
      const value = unit === "tokens" ? compactTokens(row.value) : money(row.value);
      const lines = [row.label, `${percent(row.share)} · ${value}`];
      if (row.share > 0) {
        const seg = el("div", "usage-class-seg");
        seg.style.flexGrow = String(row.share);
        seg.style.background = row.color;
        bindTooltip(root, seg, lines);
        bar.append(seg);
      }
      const item = el("div", "usage-class-row");
      const name = el("span", "usage-class-name");
      name.append(usageSwatch(row.color), el("span", "", row.label));
      item.append(name, el("strong", "usage-num", percent(row.share)), el("span", "usage-num muted", value));
      bindTooltip(root, item, lines);
      list.append(item);
    }
    wrap.append(bar, list);
  }

  function renderModels(root, summary, unit) {
    const wrap = find(root, "usage-models");
    wrap.replaceChildren();
    const models = summary.byModel || [];
    if (!models.length) {
      wrap.append(usageEmpty());
      return;
    }
    const valueOf = (m) => (unit === "tokens" ? m.activeTokens : m.costUSD) || 0;
    const max = Math.max(0, ...models.map(valueOf));
    const list = el("div", "usage-kv");
    for (const m of models) {
      const value = valueOf(m);
      const name = el("span", "usage-kv-name", shortModel(m.model));
      name.title = m.model;
      const valueCell = el("span", "usage-num");
      if (unit !== "tokens" && !m.priced) {
        valueCell.append(el("span", "usage-pill", "unpriced"), " ", el("span", "muted", `${compactTokens(m.activeTokens)} tok`));
      } else {
        valueCell.textContent = formatValue(value, unit);
      }
      list.append(name, usageMeter(max > 0 ? (value / max) * 100 : 0), valueCell);
    }
    wrap.append(list);
  }

  function typeLabel(row) {
    return row.kind === "main" ? "Main agent" : String(row.type || "subagent");
  }

  const TYPE_ROWS = 8;
  function typeRows(byType, unit) {
    const valueOf = (t) => (unit === "tokens" ? t.activeTokens : t.costUSD) || 0;
    const rows = [...(byType || [])].sort((a, b) => valueOf(b) - valueOf(a))
      .map((t) => ({ label: typeLabel(t), value: valueOf(t), runs: t.runs || 0, agents: t.agents || 0 }));
    if (rows.length <= TYPE_ROWS) return rows;
    const tail = rows.slice(TYPE_ROWS - 1);
    const sum = (key) => tail.reduce((total, row) => total + row[key], 0);
    return [...rows.slice(0, TYPE_ROWS - 1), { label: `${tail.length} other types`, value: sum("value"), runs: sum("runs"), names: tail.map((row) => row.label) }];
  }

  function effortRows(byEffort, unit) {
    const valueOf = (e) => (unit === "tokens" ? e.activeTokens : e.costUSD) || 0;
    return [...(byEffort || [])].sort((a, b) => valueOf(b) - valueOf(a))
      .map((e) => ({ label: e.effort === "unrecorded" ? "not recorded" : String(e.effort), value: valueOf(e), calls: e.calls || 0 }));
  }

  // A summary without the field (an older server) hides the card rather than calling it empty.
  function renderShares(root, id, present, rows, unit, titleOf) {
    const wrap = find(root, id);
    if (!wrap) return;
    wrap.replaceChildren();
    wrap.closest(".usage-card").hidden = !present;
    if (!rows.length) {
      wrap.append(usageEmpty());
      return;
    }
    const max = Math.max(0, ...rows.map((row) => row.value));
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const list = el("div", "usage-kv usage-kv-repos");
    for (const row of rows) {
      const valueCell = el("span", "usage-num");
      valueCell.append(
        el("span", "", formatValue(row.value, unit)),
        el("span", "usage-subtle", ` · ${total > 0 ? percent(row.value / total) : "0%"}`),
      );
      const name = el("span", "usage-kv-name", row.label);
      name.title = titleOf(row);
      list.append(name, usageMeter(max > 0 ? (row.value / max) * 100 : 0), valueCell);
    }
    wrap.append(list);
  }

  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

  function renderTypes(root, summary, unit) {
    renderShares(root, "usage-types", summary.byType !== undefined, typeRows(summary.byType, unit), unit,
      (row) => row.names ? row.names.join(", ") : `${plural(row.runs, "session")} across ${plural(row.agents, "agent")}`);
  }

  function renderEfforts(root, summary, unit) {
    renderShares(root, "usage-efforts", summary.byEffort !== undefined, effortRows(summary.byEffort, unit), unit,
      (row) => plural(row.calls, "call"));
  }

  function renderRepos(root, summary, unit) {
    const wrap = find(root, "usage-repos");
    wrap.replaceChildren();
    const repos = summary.byRepo || [];
    if (!repos.length) {
      wrap.append(usageEmpty());
      return;
    }
    const valueOf = (r) => (unit === "tokens" ? r.activeTokens : r.costUSD) || 0;
    const max = Math.max(0, ...repos.map(valueOf));
    const list = el("div", "usage-kv usage-kv-repos");
    for (const r of repos) {
      const value = valueOf(r);
      const valueCell = el("span", "usage-num");
      valueCell.append(
        el("span", "", formatValue(value, unit)),
        el("span", "usage-subtle", ` · ${r.agents} agent${r.agents === 1 ? "" : "s"}`),
      );
      list.append(
        el("span", "usage-kv-name", r.repo === "~" ? "~ (home)" : r.repo),
        usageMeter(max > 0 ? (value / max) * 100 : 0),
        valueCell,
      );
    }
    wrap.append(list);
  }

  function renderTopAgents(root, view, actions) {
    const { summary, unit, range } = view;
    const wrap = find(root, "usage-top-agents");
    wrap.replaceChildren();
    const agents = topAgents(summary, unit);
    find(root, "usage-top-heading").textContent = `Top agents · ${RANGE_LABEL[range]}`;
    if (!agents.length) {
      wrap.append(usageEmpty());
      return;
    }
    const shown = view.showAllAgents ? agents : agents.slice(0, 10);
    const max = Math.max(0, ...agents.map((a) => amountValue(a.range, unit)));
    const table = el("table", "usage-table usage-top-table");
    const htr = el("tr");
    for (const [label, cls] of [
      ["Agent", "usage-col-agent"],
      [unit === "tokens" ? RANGE_SPEND[range].replace("spend", "tokens") : RANGE_SPEND[range], "usage-col-spend"],
      ["Today", "num"],
      ["Main / subagents", "usage-col-split"],
      ["Cache writes", "num usage-col-cache"],
      ["Context now", "usage-col-context"],
      ["14 days", "usage-col-spark"],
    ]) {
      htr.append(el("th", cls, label));
    }
    const thead = el("thead");
    thead.append(htr);
    const tbody = el("tbody");
    for (const agent of shown) {
      const removed = agent.status === "removed";
      const tr = el("tr", removed ? "usage-top-row removed" : "usage-top-row clickable");

      const nameCell = el("td", "usage-col-agent");
      const nameLine = el("div", "usage-agent-name");
      nameLine.append(actions.statusDot(agent.status), el("span", "usage-agent-label", agent.name));
      const meta = [agent.repo === "~" ? "~ (home)" : agent.repo, shortModel(agent.model), agent.status].filter(Boolean).join(" · ");
      nameCell.append(nameLine, el("div", "usage-agent-meta", meta));
      nameCell.title = agent.name;

      const spend = amountLabel(agent.range, unit);
      const spendCell = el("td", "usage-col-spend");
      const spendWrap = el("div", "usage-spend");
      const value = amountValue(agent.range, unit);
      spendWrap.append(
        usageMeter(max > 0 ? (value / max) * 100 : 0),
        el("span", "usage-num" + (spend.unpriced ? " muted" : ""), spend.text),
      );
      spendCell.append(spendWrap);

      const todayValue = amountValue(agent.today, unit);
      const todayLabel = amountLabel(agent.today, unit);
      const todayCell = (agent.today?.calls || 0) > 0 || todayValue > 0
        ? el("td", "num usage-num" + (todayLabel.unpriced ? " muted" : ""), todayLabel.text)
        : el("td", "num usage-subtle", "—");

      const splitCell = el("td", "usage-col-split");
      const mainCost = agent.mainCostUSD || 0;
      const subCost = agent.subagentCostUSD || 0;
      const splitTotal = mainCost + subCost;
      const split = el("div", "usage-split-track");
      if (splitTotal > 0) {
        const main = el("div", "usage-split-main");
        main.style.flexGrow = String(mainCost / splitTotal);
        const sub = el("div", "usage-split-sub");
        sub.style.flexGrow = String(subCost / splitTotal);
        split.append(main, sub);
      }
      splitCell.append(
        split,
        el(
          "div",
          "usage-agent-meta",
          splitTotal > 0
            ? `${Math.round((subCost / splitTotal) * 100)}% subagents (${agent.subagents})`
            : `${agent.subagents} subagent${agent.subagents === 1 ? "" : "s"}`,
        ),
      );

      const writeCell = el("td", "num usage-col-cache");
      if (agent.cacheWriteShare === null || agent.cacheWriteShare === undefined) {
        writeCell.append(el("span", "usage-subtle", "—"));
      } else {
        const sev = severity(agent.cacheWriteShare, 0.45, 0.6);
        writeCell.append(el("span", "usage-pill" + (sev ? ` ${sev}` : ""), percent(agent.cacheWriteShare)));
      }

      const ctxCell = el("td", "usage-col-context");
      const ctx = agent.context;
      if (!ctx || !ctx.window || ctx.pct === null || ctx.pct === undefined) {
        ctxCell.append(el("span", "usage-subtle", "—"));
        if (ctx) ctxCell.title = `${compactTokens(ctx.tokens)} tokens · window unknown`;
      } else {
        const sev = severity(ctx.pct, 60, 80);
        const meter = el("div", "usage-context");
        meter.append(usageMeter(ctx.pct, sev), el("span", "usage-num" + (sev ? " strong" : " muted"), compactTokens(ctx.tokens)));
        ctxCell.append(meter);
        ctxCell.title = `${ctx.pct}% of ${compactTokens(ctx.window)} · peak ${compactTokens(ctx.peak)}` +
          (ctx.compactions ? ` · ${ctx.compactions} compaction${ctx.compactions === 1 ? "" : "s"}` : "");
      }

      const sparkCell = el("td", "usage-col-spark");
      const spark = sparkline(lastN(dailyValues(agent, unit), 14), { width: 86, height: 22 });
      const svg = svgEl("svg", { width: 86, height: 22, viewBox: "0 0 86 22", role: "img", "aria-label": "14-day trend" });
      svg.append(svgEl("polyline", { points: spark.points, class: "usage-spark-line" }));
      if (spark.last) svg.append(svgEl("circle", { cx: spark.last.x, cy: spark.last.y, r: 2.5, class: "usage-spark-dot" }));
      sparkCell.append(svg);

      tr.append(nameCell, spendCell, todayCell, splitCell, writeCell, ctxCell, sparkCell);
      if (!removed) {
        tr.tabIndex = 0;
        tr.setAttribute("aria-label", `Open the detailed breakdown for ${agent.name}`);
        const open = () => {
          actions.openBreakdown(agent.name);
          find(root, "usage-breakdown").scrollIntoView({ behavior: "smooth", block: "start" });
        };
        tr.onclick = open;
        tr.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        };
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    if (agents.length > 10) {
      const toggle = el("button", "text-button usage-show-all", view.showAllAgents ? "Show top 10" : `Show all ${agents.length}`);
      toggle.type = "button";
      toggle.onclick = () => actions.toggleAllAgents();
      wrap.append(toggle);
    }
  }

  // The detailed breakdown; `expanded` holds the agents whose full subagent list is shown.
  function renderBreakdown(root, report, { expanded }, actions) {
    if (!report) return;
    const { main, subagents, combined } = report.totals || {
      main: {},
      subagents: {},
      combined: {},
    };
    const subShare = combined.budgetTokens > 0
      ? Math.round((subagents.budgetTokens / combined.budgetTokens) * 100)
      : 0;
    const totalSubs = (report.agents || []).reduce((acc, a) => acc + (a.subagents?.length || 0), 0);

    // KPI strip
    const kpiWrap = find(root, "usage-kpis");
    kpiWrap.replaceChildren();
    const newInput = (combined.inputTokens || 0) + (combined.cacheCreationTokens || 0);
    for (const [label, value, detail] of [
      [
        "Active tokens (new + out)",
        compactTokens(combined.activeTokens),
        `${compactTokens(newInput)} new context · ${compactTokens(combined.outputTokens)} output`,
      ],
      [
        "Cached context reads",
        compactTokens(combined.cacheReadTokens),
        `${combined.steps ? compactTokens(Math.round((combined.cacheReadTokens || 0) / combined.steps)) : "0"} avg context / step`,
      ],
      [
        "Output tokens",
        compactTokens(combined.outputTokens),
        combined.thinkingTokens > 0
          ? `Includes ${compactTokens(combined.thinkingTokens)} reasoning tokens`
          : `Main ${compactTokens(main.outputTokens)} · Subagents ${compactTokens(subagents.outputTokens)}`,
      ],
      [
        "Subagent budget share",
        `${subShare}%`,
        `${totalSubs} subagent${totalSubs === 1 ? "" : "s"} · ${compactTokens(subagents.activeTokens)} active tokens`,
      ],
      [
        "Total API turns",
        String(combined.steps || 0),
        `Main ${main.steps || 0} · Subagents ${subagents.steps || 0}`,
      ],
    ]) {
      const card = el("div", "usage-kpi-card");
      card.append(
        el("span", "usage-kpi-label", label),
        el("strong", "usage-kpi-value", value),
        el("small", "muted", detail),
      );
      kpiWrap.append(card);
    }

    // 1a. Role pills
    const rolesWrap = find(root, "usage-roles");
    rolesWrap.replaceChildren();
    for (const role of report.byRole || []) {
      const share = combined.budgetTokens > 0
        ? Math.round((role.tokens.budgetTokens / combined.budgetTokens) * 100)
        : 0;
      const pill = el("div", "usage-role-pill");
      pill.append(
        el("span", "usage-role-name", role.role),
        el("span", "usage-pill", `${role.runs} ${role.scope === "main" ? (role.runs === 1 ? "agent" : "agents") : (role.runs === 1 ? "subagent" : "subagents")}`),
        el("strong", "mono", `${compactTokens(role.tokens.activeTokens)} active`),
        el("small", "muted", `${compactTokens(role.tokens.cacheReadTokens)} cache · ${share}%`),
      );
      rolesWrap.append(pill);
    }

    // 1b. Agents & subagents table
    const agentsWrap = find(root, "usage-agents");
    agentsWrap.replaceChildren();
    const agents = report.agents || [];
    if (!agents.length) {
      agentsWrap.append(el("p", "empty", "No token usage recorded for matching agents."));
    } else {
      const maxBudget = Math.max(1, ...agents.map((a) => a.combined.budgetTokens || 0));
      const table = el("table", "usage-table");
      const thead = el("thead");
      const htr = el("tr");
      for (const [col, cls] of [
        ["Agent / Subagent", ""],
        ["Quota share", ""],
        ["Steps", "num"],
        ["Active (new+out)", "num"],
        ["Cache read", "num"],
        ["Output", "num"],
        ["Subagents", ""],
        ["", "actions-col"],
      ]) {
        htr.append(el("th", cls, col));
      }
      thead.append(htr);
      const tbody = el("tbody");
      const scoped = find(root, "usage-agent").value;
      const singleAgentMode = Boolean(scoped) || agents.length === 1;

      for (const agent of agents) {
        const tr = el("tr", "usage-agent-row");
        const nameCell = el("td", "usage-entity-cell");
        const nameBtn = el("button", "usage-entity-btn");
        nameBtn.type = "button";
        nameBtn.append(actions.statusDot(agent.status), el("strong", "", agent.name));
        nameBtn.onclick = () => actions.openAgent(agent.name);
        const providerTag = el("span", "side-agent-provider", agent.provider);
        providerTag.dataset.provider = agent.provider;
        nameCell.append(nameBtn, providerTag);
        if (agent.role) nameCell.append(el("span", "usage-pill", agent.role));

        const shareCell = el("td", "usage-share-cell");
        const pct = Math.max(2, Math.round(((agent.combined.budgetTokens || 0) / maxBudget) * 100));
        const fleetPct = combined.budgetTokens > 0
          ? Math.round(((agent.combined.budgetTokens || 0) / combined.budgetTokens) * 100)
          : 0;
        const track = el("div", "usage-bar-track");
        const fill = el("div", "usage-bar-fill");
        fill.style.width = `${pct}%`;
        track.append(fill);
        shareCell.append(track, el("small", "mono muted", `${fleetPct}%`));

        const subCount = agent.subagents?.length || 0;
        const subCellText = subCount > 0
          ? `${subCount} (${compactTokens(agent.subagentTotals.activeTokens)} active)`
          : "—";

        const actionsCell = el("td", "actions-col");
        if (!singleAgentMode) {
          const filterBtn = el("button", "text-button", "Filter");
          filterBtn.type = "button";
          filterBtn.title = `Filter all 4 breakdowns to ${agent.name}`;
          filterBtn.onclick = () => filterAgent(root, agent.name, actions);
          actionsCell.append(filterBtn);
        } else if (scoped) {
          const allBtn = el("button", "text-button", "All agents");
          allBtn.type = "button";
          allBtn.onclick = () => filterAgent(root, "", actions);
          actionsCell.append(allBtn);
        }

        tr.append(
          nameCell,
          shareCell,
          el("td", "num mono", String(agent.combined.steps || 0)),
          el("td", "num mono strong", compactTokens(agent.combined.activeTokens)),
          el("td", "num mono muted", compactTokens(agent.combined.cacheReadTokens)),
          el("td", "num mono", compactTokens(agent.combined.outputTokens)),
          el("td", "muted", subCellText),
          actionsCell,
        );
        tbody.append(tr);

        const subsWithTokens = (agent.subagents || []).filter((s) => (s.tokens?.totalTokens || 0) > 0);
        const isExpanded = singleAgentMode || expanded.has(agent.name);
        const visibleSubs = isExpanded ? subsWithTokens : subsWithTokens.slice(0, 4);

        for (const sub of visibleSubs) {
          const str = el("tr", "usage-subagent-row");
          const sNameCell = el("td", "usage-entity-cell usage-subagent-cell");
          const sBtn = el("button", "usage-subagent-btn");
          sBtn.type = "button";
          sBtn.append(
            el("span", "muted", "⤷"),
            el("span", "usage-pill role", sub.role || sub.type),
            el("span", "usage-subagent-label", sub.label),
          );
          if (sub.workflow) sBtn.append(el("span", "usage-pill workflow", sub.workflow));
          if (sub.cacheBusts > 0) {
            sBtn.append(el("span", "usage-pill warn", `${sub.cacheBusts} cache-bust${sub.cacheBusts === 1 ? "" : "s"}`));
          }
          const statusLabel = sub.status === "running" ? "Running" : sub.status === "stale" ? "Session ended" : "Finished";
          sBtn.onclick = () => actions.openSubagent(agent.name, sub.id, sub.label, statusLabel);
          sNameCell.append(sBtn);

          const sShareCell = el("td", "usage-share-cell");
          const sPct = agent.combined.budgetTokens > 0
            ? Math.round(((sub.tokens.budgetTokens || 0) / agent.combined.budgetTokens) * 100)
            : 0;
          sShareCell.append(el("small", "mono muted", `${sPct}% of agent`));

          str.append(
            sNameCell,
            sShareCell,
            el("td", "num mono muted", String(sub.tokens.steps || 0)),
            el("td", "num mono", compactTokens(sub.tokens.activeTokens)),
            el("td", "num mono muted", compactTokens(sub.tokens.cacheReadTokens)),
            el("td", "num mono muted", compactTokens(sub.tokens.outputTokens)),
            el("td", "muted", statusLabel),
            el("td", "actions-col"),
          );
          tbody.append(str);
        }

        if (!singleAgentMode && subsWithTokens.length > 4) {
          const moreTr = el("tr", "usage-subagent-more");
          const moreTd = el("td");
          moreTd.colSpan = 8;
          const toggleBtn = el(
            "button",
            "text-button",
            isExpanded
              ? "Show fewer subagents"
              : `Show all ${subsWithTokens.length} subagents (+${subsWithTokens.length - 4} more)`,
          );
          toggleBtn.type = "button";
          toggleBtn.onclick = () => actions.toggleSubagents(agent.name);
          moreTd.append(toggleBtn);
          moreTr.append(moreTd);
          tbody.append(moreTr);
        }
      }
      table.append(thead, tbody);
      agentsWrap.append(table);
    }

    // 2. Workflows table
    const wfWrap = find(root, "usage-workflows");
    wfWrap.replaceChildren();
    const workflows = report.workflows || [];
    if (!workflows.length) {
      wfWrap.append(el("p", "empty", "No workflow activity recorded."));
    } else {
      const maxWf = Math.max(1, ...workflows.map((w) => w.tokens.budgetTokens || 0));
      const table = el("table", "usage-table compact");
      const thead = el("thead");
      const htr = el("tr");
      for (const [col, cls] of [
        ["Workflow / Skill", ""],
        ["Share", ""],
        ["Runs", "num"],
        ["Steps", "num"],
        ["Active", "num"],
        ["Cache read", "num"],
        ["Out", "num"],
      ]) {
        htr.append(el("th", cls, col));
      }
      thead.append(htr);
      const tbody = el("tbody");
      for (const wf of workflows.slice(0, 12)) {
        const tr = el("tr");
        const pct = Math.max(2, Math.round(((wf.tokens.budgetTokens || 0) / maxWf) * 100));
        const shareCell = el("td", "usage-share-cell");
        const track = el("div", "usage-bar-track");
        const fill = el("div", "usage-bar-fill");
        fill.style.width = `${pct}%`;
        track.append(fill);
        shareCell.append(track);
        tr.append(
          el("td", "mono strong", wf.workflow),
          shareCell,
          el("td", "num mono muted", String(wf.runs)),
          el("td", "num mono muted", String(wf.tokens.steps)),
          el("td", "num mono strong", compactTokens(wf.tokens.activeTokens)),
          el("td", "num mono muted", compactTokens(wf.tokens.cacheReadTokens)),
          el("td", "num mono muted", compactTokens(wf.tokens.outputTokens)),
        );
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wfWrap.append(table);
    }

    // 3. Tools & command categories table
    const toolsWrap = find(root, "usage-tools");
    toolsWrap.replaceChildren();
    const tools = report.tools || [];
    if (!tools.length) {
      toolsWrap.append(el("p", "empty", "No tool calls recorded."));
    } else {
      const maxTool = Math.max(1, ...tools.map((t) => t.tokens.budgetTokens || 0));
      const table = el("table", "usage-table compact");
      const thead = el("thead");
      const htr = el("tr");
      for (const [col, cls] of [
        ["Category", ""],
        ["Share", ""],
        ["Calls", "num"],
        ["Steps", "num"],
        ["Active", "num"],
        ["Cache read", "num"],
        ["Out", "num"],
      ]) {
        htr.append(el("th", cls, col));
      }
      thead.append(htr);
      const tbody = el("tbody");
      for (const tool of tools.slice(0, 12)) {
        const tr = el("tr");
        const pct = Math.max(2, Math.round(((tool.tokens.budgetTokens || 0) / maxTool) * 100));
        const shareCell = el("td", "usage-share-cell");
        const track = el("div", "usage-bar-track");
        const fill = el("div", "usage-bar-fill");
        fill.style.width = `${pct}%`;
        track.append(fill);
        shareCell.append(track);
        tr.append(
          el("td", "strong", tool.category),
          shareCell,
          el("td", "num mono muted", String(tool.calls)),
          el("td", "num mono muted", String(tool.tokens.steps)),
          el("td", "num mono strong", compactTokens(tool.tokens.activeTokens)),
          el("td", "num mono muted", compactTokens(tool.tokens.cacheReadTokens)),
          el("td", "num mono muted", compactTokens(tool.tokens.outputTokens)),
        );
        tbody.append(tr);
      }
      table.append(thead, tbody);
      toolsWrap.append(table);
    }

    // 4. Anomalies list
    const anomWrap = find(root, "usage-anomalies");
    anomWrap.replaceChildren();
    const anomalies = report.anomalies || [];
    if (!anomalies.length) {
      anomWrap.append(el("p", "empty", "No major token budget anomalies detected."));
    } else {
      for (const item of anomalies) {
        const card = el("div", "usage-anomaly-card");
        const top = el("div", "usage-anomaly-top");
        const kindBadge = el("span", `usage-pill anomaly-${item.kind}`, item.kind);
        const targetBtn = el(
          "button",
          "text-button usage-anomaly-target",
          item.subagentLabel ? `${item.agent} › ${item.subagentLabel}` : item.agent,
        );
        targetBtn.type = "button";
        targetBtn.onclick = () => {
          if (item.subagentId) {
            actions.openSubagent(item.agent, item.subagentId, item.subagentLabel || item.subagentId, "Finished");
          } else {
            actions.openAgent(item.agent);
          }
        };
        const impact = el("span", "mono usage-anomaly-impact", `${compactTokens(item.tokens)} tok`);
        top.append(kindBadge, targetBtn, impact);
        card.append(
          top,
          el("p", "usage-anomaly-title", item.title),
          el("small", "muted", item.detail),
        );
        anomWrap.append(card);
      }
    }
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
    typeRows,
    effortRows,
    formatResetCountdown,
    buildPage,
    bindControls,
    populateAgentSelect,
    renderQuota,
    renderDashboard,
    renderChart,
    renderTopAgents,
    renderBreakdown,
  };
})();
