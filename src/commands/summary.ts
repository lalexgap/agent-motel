import { fleetRows } from "../fleet";
import { buildFleetSummary, formatFleetSummary } from "../summary";
import { gcSummaryLine } from "../autoGc";

export function summaryCommand(opts: { json?: boolean; localOnly?: boolean } = {}): void {
  const summary = buildFleetSummary(fleetRows({ localOnly: opts.localOnly }), new Date(), gcSummaryLine());
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(formatFleetSummary(summary).join("\n"));
}
