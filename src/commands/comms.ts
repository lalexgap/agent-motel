import { resolveAgent } from "../state";
import { commsFor } from "../comms";

const KINDS_PAD = "interrupt".length;

function truncate(s: string, max = 64): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// `am comms <name>`: recent attributed messages touching an agent, in either
// direction, oldest→newest. Reads the shared ledger that also drives the rate
// limiter, so it shows exactly what loop protection sees.
export function commsCommand(prefix: string, opts: { limit?: number } = {}): void {
  const agent = resolveAgent(prefix);
  const entries = commsFor(agent.name, opts.limit ?? 20);
  if (entries.length === 0) {
    console.log(`no recorded messages for "${agent.name}"`);
    return;
  }
  for (const e of entries) {
    const fromBase = e.from.includes(":") ? e.from.slice(e.from.indexOf(":") + 1) : e.from;
    const outgoing = fromBase === agent.name;
    const arrow = outgoing ? "→" : "←";
    const peer = outgoing ? e.to : e.from;
    const time = e.at.slice(11, 19);
    console.log(`${time}  ${arrow} ${peer.padEnd(16)} ${e.kind.padEnd(KINDS_PAD)}  ${truncate(e.body)}`);
  }
}
