// Deterministic synthetic usage for the fixture am server: 30 days per agent,
// derived from a hash of the agent's name, so every run (and every reset)
// shows the same dashboard apart from the calendar dates.
import type { FixtureRow } from "./data";
import { FIXTURE_LOCAL_HOST } from "./data";
import type { Subagent } from "./extras";

const DAYS = 30;
const STOPPED = new Set(["exited", "dead"]);

// $ per million tokens: input, cache write, cache read, output. Absent = unpriced.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-4-5": [5, 6.25, 0.5, 25],
  "claude-sonnet-4-5": [3, 3.75, 0.3, 15],
  "claude-haiku-4-5": [1, 1.25, 0.1, 5],
  "gpt-5.2-codex": [1.25, 0, 0.125, 10],
  "gpt-5.2": [1.25, 0, 0.125, 10],
};
const BASE: Record<string, number> = {
  "claude-opus-4-5": 380_000, "claude-sonnet-4-5": 260_000, "claude-haiku-4-5": 90_000, "gpt-5.2-codex": 300_000, "gemini-3-pro": 150_000,
};
const DEFAULT_MODEL: Record<string, string> = { claude: "claude-sonnet-4-5", codex: "gpt-5.2-codex", antigravity: "gemini-3-pro" };

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return value >>> 0;
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Day { input: number; cacheWrite: number; cacheRead: number; output: number; calls: number }
export interface History {
  name: string;
  provider: string;
  repo?: string;
  role?: string;
  model: string;
  days: Day[];
  subagents: number;
  subShare: number;
  removed?: true;
}

const zero = (): Day => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 });

function series(seed: string, base: number, first: number, last: number, busyToday: boolean): Day[] {
  const next = random(hash(seed));
  return Array.from({ length: DAYS }, (_, day) => {
    const roll = next(), size = next(), reads = next(), writes = next();
    if (day < first || day > last || (roll < 0.3 && !(day === DAYS - 1 && busyToday))) return zero();
    const active = Math.round(base * (0.35 + size * 1.3));
    const cacheWrite = Math.round(active * 0.25 * (0.6 + writes * 0.8));
    const output = Math.round(active * 0.12);
    return { input: active - cacheWrite - output, cacheWrite, cacheRead: Math.round(active * (5 + reads * 15)), output, calls: Math.max(1, Math.round(active / 6000)) };
  });
}

export function historyFor(row: FixtureRow, now: number): History {
  const model = row.model ?? DEFAULT_MODEL[row.provider] ?? "unknown";
  const ageDays = Math.ceil((now - Date.parse(row.createdAt)) / 86_400_000);
  const idleDays = STOPPED.has(row.status) ? Math.floor((now - Date.parse(row.statusChangedAt)) / 86_400_000) : 0;
  const next = random(hash(`share:${row.name}`));
  const harbor = row.name === "harbor-lights";
  const subShare = harbor ? 0.22 : Math.round(next() * 15) / 100;
  return {
    name: row.name, provider: row.provider, repo: row.repoRoot?.split("/").pop(), ...(typeof row.role === "string" ? { role: row.role } : {}), model,
    days: series(row.name, BASE[model] ?? 200_000, Math.max(0, DAYS - ageDays), DAYS - 1 - idleDays, row.status === "working"),
    subagents: harbor ? 3 : Math.floor(subShare * 20), subShare,
  };
}

// A reviewer that finished and was removed last week: still in the ledger.
export function removedHistories(): History[] {
  return [{
    name: "beacon-audit", provider: "claude", repo: "lighthouse", role: "reviewer", model: "claude-sonnet-4-5",
    days: series("beacon-audit", 220_000, 21, 26, false), subagents: 2, subShare: 0.1, removed: true,
  }];
}

const priced = (model: string) => model in PRICES;
const dayCost = (model: string, day: Day) => {
  const price = PRICES[model];
  if (!price) return 0;
  return (day.input * price[0] + day.cacheWrite * price[1] + day.cacheRead * price[2] + day.output * price[3]) / 1e6;
};
const activeOf = (day: Day) => day.input + day.cacheWrite + day.output;
const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

interface UsageAmount { costUSD: number; activeTokens: number; cacheReadTokens: number; unpricedActiveTokens: number; calls: number }
function amount(model: string, days: Day[]): UsageAmount {
  const total: UsageAmount = { costUSD: 0, activeTokens: 0, cacheReadTokens: 0, unpricedActiveTokens: 0, calls: 0 };
  for (const day of days) {
    total.costUSD += dayCost(model, day);
    total.activeTokens += activeOf(day);
    total.cacheReadTokens += day.cacheRead;
    if (!priced(model)) total.unpricedActiveTokens += activeOf(day);
    total.calls += day.calls;
  }
  total.costUSD = round(total.costUSD);
  return total;
}
function addAmount(a: UsageAmount, b: UsageAmount): UsageAmount {
  return {
    costUSD: round(a.costUSD + b.costUSD), activeTokens: a.activeTokens + b.activeTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    unpricedActiveTokens: a.unpricedActiveTokens + b.unpricedActiveTokens, calls: a.calls + b.calls,
  };
}
const emptyAmount = (): UsageAmount => ({ costUSD: 0, activeTokens: 0, cacheReadTokens: 0, unpricedActiveTokens: 0, calls: 0 });

// Fleet chatter no current agent owns: hub summaries, the daemon's own calls.
const UNATTRIBUTED = series("unattributed", 40_000, 0, DAYS - 1, true);
const UNATTRIBUTED_MODEL = "claude-haiku-4-5";

function localDays(now: number): string[] {
  return Array.from({ length: DAYS }, (_, index) => {
    const date = new Date(now - (DAYS - 1 - index) * 86_400_000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
}

export interface SummaryEntry { history: History; row?: FixtureRow }

export function usageSummary(entries: SummaryEntry[], opts: { range: 1 | 7 | 30; repo?: string; provider?: string }, now: number) {
  const repoKey = (history: History) => history.repo ?? "~";
  const all = entries;
  const chosen = all.filter(({ history }) => (!opts.provider || history.provider === opts.provider) && (!opts.repo || repoKey(history) === opts.repo));
  const from = DAYS - opts.range;
  const withUnattributed = !opts.repo && !opts.provider;
  const totalOver = (start: number) => {
    let total = withUnattributed ? amount(UNATTRIBUTED_MODEL, UNATTRIBUTED.slice(start)) : emptyAmount();
    for (const { history } of chosen) total = addAmount(total, amount(history.model, history.days.slice(start)));
    return total;
  };
  const classes = { cacheRead: { costUSD: 0, tokens: 0 }, cacheWrite1h: { costUSD: 0, tokens: 0 }, cacheWrite5m: { costUSD: 0, tokens: 0 }, output: { costUSD: 0, tokens: 0 }, input: { costUSD: 0, tokens: 0 } };
  const byModel = new Map<string, { model: string; priced: boolean; costUSD: number; activeTokens: number }>();
  const byRepo = new Map<string, { repo: string; costUSD: number; activeTokens: number; agents: number }>();
  const agents = [];
  for (const { history, row } of chosen) {
    const range = amount(history.model, history.days.slice(from));
    if (!range.activeTokens && !(row && !STOPPED.has(row.status))) continue;
    const price = PRICES[history.model];
    for (const day of history.days.slice(from)) {
      const longWrite = Math.round(day.cacheWrite * 0.4);
      classes.cacheRead.tokens += day.cacheRead;
      classes.cacheWrite1h.tokens += longWrite;
      classes.cacheWrite5m.tokens += day.cacheWrite - longWrite;
      classes.output.tokens += day.output;
      classes.input.tokens += day.input;
      if (price) {
        classes.cacheRead.costUSD += (day.cacheRead * price[2]) / 1e6;
        classes.cacheWrite1h.costUSD += (longWrite * price[1] * 1.6) / 1e6;
        classes.cacheWrite5m.costUSD += ((day.cacheWrite - longWrite) * price[1]) / 1e6;
        classes.output.costUSD += (day.output * price[3]) / 1e6;
        classes.input.costUSD += (day.input * price[0]) / 1e6;
      }
    }
    const model = byModel.get(history.model) ?? { model: history.model, priced: priced(history.model), costUSD: 0, activeTokens: 0 };
    model.costUSD = round(model.costUSD + range.costUSD);
    model.activeTokens += range.activeTokens;
    byModel.set(history.model, model);
    const repo = byRepo.get(repoKey(history)) ?? { repo: repoKey(history), costUSD: 0, activeTokens: 0, agents: 0 };
    repo.costUSD = round(repo.costUSD + range.costUSD);
    repo.activeTokens += range.activeTokens;
    if (range.activeTokens) repo.agents++;
    byRepo.set(repo.repo, repo);
    const slice = history.days.slice(from);
    const writes = slice.reduce((sum, day) => sum + day.cacheWrite, 0);
    const reads = slice.reduce((sum, day) => sum + day.cacheRead, 0);
    const inputs = slice.reduce((sum, day) => sum + day.input, 0);
    const live = !!row && !STOPPED.has(row.status);
    const window = history.provider === "codex" ? 272_000 : history.provider === "claude" ? 200_000 : null;
    const contextTokens = 20_000 + (hash(`ctx:${history.name}`) % 140_000);
    agents.push({
      name: row?.name ?? history.name, provider: history.provider, ...(history.repo ? { repo: history.repo } : {}), ...(history.role ? { role: history.role } : {}), model: history.model,
      status: row?.status ?? "removed", live, range, today: amount(history.model, history.days.slice(DAYS - 1)),
      mainCostUSD: round(range.costUSD * (1 - history.subShare)), subagentCostUSD: round(range.costUSD * history.subShare), subagents: history.subagents,
      cacheWriteShare: range.activeTokens ? round(writes / range.activeTokens, 3) : null,
      cacheHitRate: reads + inputs + writes ? round(reads / (reads + inputs + writes), 3) : null,
      context: live ? { tokens: contextTokens, window, pct: window ? round((contextTokens / window) * 100, 1) : null, peak: Math.min(contextTokens + 30_000, window ?? contextTokens + 30_000), compactions: hash(`cmp:${history.name}`) % 3 } : null,
      dailyCostUSD: history.days.map((day) => round(dayCost(history.model, day))),
      dailyActiveTokens: history.days.map(activeOf),
    });
  }
  for (const value of Object.values(classes)) value.costUSD = round(value.costUSD);
  agents.sort((a, b) => b.range.costUSD - a.range.costUSD || b.range.activeTokens - a.range.activeTokens || a.name.localeCompare(b.name));
  return {
    generatedAt: new Date(now).toISOString(),
    host: FIXTURE_LOCAL_HOST,
    indexing: { pendingFiles: 0 },
    days: localDays(now),
    totals: { today: totalOver(DAYS - 1), last7: totalOver(DAYS - 7), last30: totalOver(0) },
    classes,
    byModel: [...byModel.values()].sort((a, b) => b.costUSD - a.costUSD || b.activeTokens - a.activeTokens),
    byRepo: [...byRepo.values()].sort((a, b) => b.costUSD - a.costUSD || b.activeTokens - a.activeTokens),
    agents,
    unattributed: withUnattributed
      ? { dailyCostUSD: UNATTRIBUTED.map((day) => round(dayCost(UNATTRIBUTED_MODEL, day))), dailyActiveTokens: UNATTRIBUTED.map(activeOf), range: amount(UNATTRIBUTED_MODEL, UNATTRIBUTED.slice(from)) }
      : { dailyCostUSD: Array(DAYS).fill(0), dailyActiveTokens: Array(DAYS).fill(0), range: emptyAmount() },
    filters: {
      repos: [...new Set(all.map(({ history }) => repoKey(history)))].sort(),
      providers: [...new Set(all.map(({ history }) => history.provider))].sort(),
    },
  };
}

export function quota(now: number) {
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  return [
    { provider: "claude", plan: "max", windows: [
      { label: "5h", utilization: 42, resetsAt: at(2.5) },
      { label: "week", utilization: 68, resetsAt: at(70) },
      { label: "week (opus)", utilization: 81, resetsAt: at(70) },
    ] },
    { provider: "codex", plan: "pro", observedAt: new Date(now - 4 * 60_000).toISOString(), windows: [
      { label: "5h", utilization: 17, resetsAt: at(4) },
      { label: "week", utilization: 93, resetsAt: at(30) },
    ] },
  ];
}

// --- per-agent token reports (AgentTokenReport / FleetTokenReport) -----------

interface Buckets {
  steps: number; inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; thinkingTokens: number;
  activeTokens: number; totalTokens: number; budgetTokens: number; costUSD?: number;
}

function buckets(model: string | undefined, raw: { steps: number; input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number }): Buckets {
  const result: Buckets = {
    steps: raw.steps, inputTokens: raw.input, cacheCreationTokens: raw.cacheWrite, cacheReadTokens: raw.cacheRead, outputTokens: raw.output, thinkingTokens: raw.thinking,
    activeTokens: raw.input + raw.cacheWrite + raw.output,
    totalTokens: raw.input + raw.cacheWrite + raw.cacheRead + raw.output,
    budgetTokens: Math.round(raw.input + raw.cacheWrite * 1.25 + raw.cacheRead * 0.1 + raw.output * 5),
  };
  if (model && priced(model)) result.costUSD = round(dayCost(model, { input: raw.input, cacheWrite: raw.cacheWrite, cacheRead: raw.cacheRead, output: raw.output, calls: 0 }));
  return result;
}
function sum(model: string | undefined, list: Buckets[]): Buckets {
  const total = list.reduce((acc, item) => ({
    steps: acc.steps + item.steps, input: acc.input + item.inputTokens, cacheWrite: acc.cacheWrite + item.cacheCreationTokens,
    cacheRead: acc.cacheRead + item.cacheReadTokens, output: acc.output + item.outputTokens, thinking: acc.thinking + item.thinkingTokens,
  }), { steps: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 });
  const result = buckets(model, total);
  const costs = list.filter((item) => item.costUSD !== undefined);
  if (costs.length) result.costUSD = round(costs.reduce((acc, item) => acc + item.costUSD!, 0));
  else delete result.costUSD;
  return result;
}
const scale = (model: string, days: Day[], share: number) => {
  const total = days.reduce((acc, day) => ({ input: acc.input + day.input, cacheWrite: acc.cacheWrite + day.cacheWrite, cacheRead: acc.cacheRead + day.cacheRead, output: acc.output + day.output, calls: acc.calls + day.calls }), zero());
  const part = (value: number) => Math.round(value * share);
  return buckets(model, { steps: part(total.calls), input: part(total.input), cacheWrite: part(total.cacheWrite), cacheRead: part(total.cacheRead), output: part(total.output), thinking: part(total.output * 0.3) });
};

export function agentTokenReport(row: FixtureRow, history: History | undefined, subagents: Subagent[]) {
  const model = history?.model;
  // The current session: the last week of the agent's history.
  const recent = history?.days.slice(DAYS - 7) ?? [];
  const main = history ? scale(history.model, recent, 1 - history.subShare) : buckets(undefined, { steps: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 });
  const records = subagents.length
    ? subagents.map(({ record }) => {
      const tokens = record.tokens
        ? buckets(model, { steps: record.tokens.steps, input: record.tokens.inputTokens, cacheWrite: record.tokens.cacheCreationTokens, cacheRead: record.tokens.cacheReadTokens, output: record.tokens.outputTokens, thinking: record.tokens.thinkingTokens ?? 0 })
        : scale(model ?? "", recent, 0.03);
      return { id: record.id, type: record.type, role: record.type === "Explore" ? "explore" : "general", label: record.description ?? record.type, startedAt: record.startedAt, ...(record.endedAt ? { endedAt: record.endedAt } : {}), status: (record.endedAt ? "finished" : STOPPED.has(row.status) ? "stale" : "running") as "finished" | "running" | "stale", ...(model ? { model } : {}), tokens, cacheBusts: 0 };
    })
    : Array.from({ length: Math.min(3, history?.subagents ?? 0) }, (_, index) => {
      const startedAt = new Date(Date.parse(row.createdAt) + (index + 1) * 600_000).toISOString();
      return {
        id: (hash(`${row.name}:${index}`).toString(16) + "00000000").slice(0, 16), type: index % 2 ? "Explore" : "general-purpose", role: index % 2 ? "explore" : "general",
        label: index % 2 ? "Map the call sites" : "Run the slow test shard", startedAt, endedAt: new Date(Date.parse(startedAt) + 240_000).toISOString(),
        status: "finished" as const, ...(model ? { model } : {}), tokens: scale(model ?? "", recent, (history?.subShare ?? 0) / 3), cacheBusts: 0,
      };
    });
  const subagentTotals = sum(model, records.map((item) => item.tokens));
  const combined = sum(model, [main, subagentTotals]);
  const role = typeof row.role === "string" ? row.role : undefined;
  const byRole: { role: string; scope: "main" | "subagent"; runs: number; tokens: Buckets }[] = [{ role: role ?? "main", scope: "main", runs: 1, tokens: main }];
  for (const record of records) {
    const existing = byRole.find((item) => item.role === record.role && item.scope === "subagent");
    if (existing) {
      existing.runs++;
      existing.tokens = sum(model, [existing.tokens, record.tokens]);
    } else byRole.push({ role: record.role, scope: "subagent", runs: 1, tokens: record.tokens });
  }
  const share = (fraction: number) => scale(model ?? "", recent, fraction * (1 - (history?.subShare ?? 0)));
  const active = combined.activeTokens > 0;
  return {
    name: row.name, provider: row.provider, status: row.status, ...(role ? { role } : {}), ...(model ? { model } : {}), updatedAt: row.updatedAt,
    main, subagentTotals, combined, subagents: records, byRole,
    workflows: active ? [{ workflow: "testing", runs: 6, tokens: share(0.3) }, { workflow: "code-review", runs: 2, tokens: share(0.1) }] : [],
    tools: active ? [
      { category: "read", calls: 42, tokens: share(0.25) },
      { category: "edit", calls: 17, tokens: share(0.2) },
      { category: "bash: test", calls: 9, tokens: share(0.15) },
      { category: "search", calls: 23, tokens: share(0.1) },
    ] : [],
    anomalies: row.name === "harbor-lights" && active
      ? [{ kind: "cache-bust", agent: row.name, title: "Cache rebuilt after a 7 min pause", detail: "38.2k tokens re-written to cache when the turn resumed after the test run.", tokens: 38_200, timestamp: new Date(Date.parse(row.updatedAt) - 1_800_000).toISOString() }]
      : [],
  };
}

type Report = ReturnType<typeof agentTokenReport>;
export function fleetTokenReport(reports: Report[], now: number) {
  const merge = <T extends { tokens: Buckets }>(lists: T[][], key: (item: T) => string, count: (item: T) => number, field: "runs" | "calls") => {
    const map = new Map<string, T>();
    for (const item of lists.flat()) {
      const existing = map.get(key(item));
      if (!existing) map.set(key(item), { ...item });
      else {
        (existing as Record<string, unknown>)[field] = count(existing) + count(item);
        existing.tokens = sum(undefined, [existing.tokens, item.tokens]);
      }
    }
    return [...map.values()].sort((a, b) => b.tokens.activeTokens - a.tokens.activeTokens);
  };
  return {
    generatedAt: new Date(now).toISOString(),
    host: FIXTURE_LOCAL_HOST,
    totals: {
      main: sum(undefined, reports.map((report) => report.main)),
      subagents: sum(undefined, reports.map((report) => report.subagentTotals)),
      combined: sum(undefined, reports.map((report) => report.combined)),
    },
    agents: reports,
    byRole: merge(reports.map((report) => report.byRole), (item) => `${item.scope}:${item.role}`, (item) => item.runs, "runs"),
    workflows: merge(reports.map((report) => report.workflows), (item) => item.workflow, (item) => item.runs, "runs"),
    tools: merge(reports.map((report) => report.tools), (item) => item.category, (item) => item.calls, "calls"),
    anomalies: reports.flatMap((report) => report.anomalies).sort((a, b) => b.tokens - a.tokens).slice(0, 15),
  };
}
