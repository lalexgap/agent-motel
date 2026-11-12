import { fleetRows } from "../fleet";
import { buildPrReport, formatPrReport } from "../prReport";
import { PR_STATES, type PrState } from "../prStatus";

export function prsCommand(opts: { json?: boolean; localOnly?: boolean; all?: boolean; needsMe?: boolean; repo?: string; state?: string } = {}): void {
  if (opts.state !== undefined && !PR_STATES.includes(opts.state as PrState)) {
    throw new Error(`unknown PR state "${opts.state}" (expected ${PR_STATES.join(", ")})`);
  }
  const report = buildPrReport(fleetRows({ localOnly: opts.localOnly }), new Date(), {
    all: opts.all, needsMe: opts.needsMe, repo: opts.repo, state: opts.state as PrState | undefined,
  });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatPrReport(report, new Date()).join("\n"));
}
