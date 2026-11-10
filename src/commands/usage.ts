import { collectUsage, formatUsageReport, type UsageProvider } from "../usage";
import { collectFleetTokenUsage, formatTokenReportLines, formatTokens } from "../tokenUsage";
import type { Provider } from "../state";
import { refreshUsageLedger, SUMMARY_RANGES, usageSummary, type SummaryRange, type UsageSummary } from "../usageLedger";

export interface UsageCommandOpts {
  json?: boolean;
  provider?: string;
  agent?: string;
  tokensOnly?: boolean;
  quotaOnly?: boolean;
  summary?: boolean;
  days?: number;
}

export async function usageCommand(opts: UsageCommandOpts = {}): Promise<void> {
  if (opts.summary) {
    usageSummaryCommand(opts);
    return;
  }
  if (opts.provider && !["claude", "codex", "antigravity"].includes(opts.provider)) {
    throw new Error(`unknown provider "${opts.provider}" (expected claude, codex, or antigravity)`);
  }
  if (opts.provider === "antigravity" && opts.quotaOnly) {
    throw new Error("antigravity quota usage is unsupported");
  }
  const providers =
    opts.provider && opts.provider !== "antigravity"
      ? [opts.provider as UsageProvider]
      : undefined;

  const color = process.stdout.isTTY ?? false;

  // Single-agent, tokens-only, or Antigravity inspection skips OAuth quota probes.
  if (opts.agent || opts.tokensOnly || opts.provider === "antigravity") {
    const tokens = collectFleetTokenUsage({
      provider: opts.provider as Provider | undefined,
      agentName: opts.agent,
    });
    if (opts.json) {
      console.log(JSON.stringify(opts.agent ? (tokens.agents[0] ?? null) : tokens, null, 2));
      return;
    }
    console.log(formatTokenReportLines(tokens, { color, singleAgent: !!opts.agent }).join("\n"));
    return;
  }

  const [report, tokens] = await Promise.all([
    collectUsage({ providers }),
    Promise.resolve(
      opts.quotaOnly
        ? null
        : collectFleetTokenUsage({ provider: opts.provider as Provider | undefined }),
    ),
  ]);

  if (opts.json) {
    console.log(JSON.stringify(tokens ? { ...report, tokens } : report, null, 2));
    return;
  }

  const lines = formatUsageReport(report, { color });
  if (tokens && tokens.agents.length > 0) {
    lines.push("", ...formatTokenReportLines(tokens, { color }));
  }
  console.log(lines.join("\n"));
}

function usageSummaryCommand(opts: UsageCommandOpts): void {
  if (opts.provider && !["claude", "codex", "antigravity"].includes(opts.provider)) {
    throw new Error(`unknown provider "${opts.provider}" (expected claude, codex, or antigravity)`);
  }
  const range = (opts.days ?? 7) as SummaryRange;
  if (!SUMMARY_RANGES.includes(range)) throw new Error("--days must be 1, 7, or 30");
  // Keep slicing until the backlog is indexed, so a first run backfills fully.
  for (;;) {
    const result = refreshUsageLedger({ budgetMs: 1000 });
    if (result.pendingFiles === 0) break;
    if (result.skipped) Bun.sleepSync(250); // another process holds the ledger lock
  }
  const summary = usageSummary({ range, provider: opts.provider as Provider | undefined });
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(formatUsageSummaryLines(summary, range).join("\n"));
}

function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatUsageSummaryLines(summary: UsageSummary, range: SummaryRange): string[] {
  const { today, last7, last30 } = summary.totals;
  const unpriced = last30.unpricedActiveTokens > 0 ? ` (+${formatTokens(last30.unpricedActiveTokens)} unpriced tokens in 30d)` : "";
  const lines = [
    `spend  today ${dollars(today.costUSD)} · 7d ${dollars(last7.costUSD)} · 30d ${dollars(last30.costUSD)}${unpriced}`,
  ];
  if (summary.indexing.pendingFiles > 0) lines.push(`indexing: ${summary.indexing.pendingFiles} transcript(s) still pending`);
  const top = summary.agents.slice(0, 10);
  if (top.length === 0) {
    lines.push("", "No usage recorded in the selected range.");
    return lines;
  }
  const nameWidth = Math.min(28, Math.max(5, ...top.map((a) => a.name.length)));
  lines.push("", `${"AGENT".padEnd(nameWidth)}  ${`${range}D COST`.padStart(9)}  ${"ACTIVE".padStart(7)}  ${"CONTEXT".padStart(7)}  STATUS`);
  for (const agent of top) {
    const name = agent.name.length > nameWidth ? `${agent.name.slice(0, nameWidth - 1)}…` : agent.name.padEnd(nameWidth);
    const cost = agent.range.unpricedActiveTokens > 0 && agent.range.costUSD === 0 ? "unpriced" : dollars(agent.range.costUSD);
    const ctx = agent.context?.pct != null ? `${Math.round(agent.context.pct)}%` : "—";
    lines.push(`${name}  ${cost.padStart(9)}  ${formatTokens(agent.range.activeTokens).padStart(7)}  ${ctx.padStart(7)}  ${agent.status}`);
  }
  if (summary.unattributed.range.calls > 0) {
    lines.push(`${"(no agent)".padEnd(nameWidth)}  ${dollars(summary.unattributed.range.costUSD).padStart(9)}  ${formatTokens(summary.unattributed.range.activeTokens).padStart(7)}`);
  }
  return lines;
}
