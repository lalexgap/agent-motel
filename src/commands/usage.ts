import { collectUsage, formatUsageReport, type UsageProvider } from "../usage";
import { collectFleetTokenUsage, formatTokenReportLines } from "../tokenUsage";
import type { Provider } from "../state";

export interface UsageCommandOpts {
  json?: boolean;
  provider?: string;
  agent?: string;
  tokensOnly?: boolean;
  quotaOnly?: boolean;
}

export async function usageCommand(opts: UsageCommandOpts = {}): Promise<void> {
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
