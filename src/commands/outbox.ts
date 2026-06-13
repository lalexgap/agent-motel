import { outboxList, outboxTake } from "../outbox";
import { relativeTime } from "./ls";

function clip(body: string, max = 50): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// `am outbox --take <names...>`: atomically return-and-remove live entries for
// those names as JSON. This is the collector's pickup call over ssh — the only
// machine-readable path. Everything else is human inspection.
export function outboxCommand(names: string[], opts: { take?: boolean }): void {
  if (opts.take) {
    console.log(JSON.stringify(outboxTake(names)));
    return;
  }

  const { live, bounced } = outboxList();
  if (live.length === 0 && bounced.length === 0) {
    console.log("outbox empty");
    return;
  }

  if (live.length > 0) {
    console.log(`outbox — ${live.length} awaiting pickup:`);
    for (const e of live) {
      const who = e.from ? `${e.from}@${e.fromHost}` : e.fromHost;
      console.log(`  → ${e.to.padEnd(14)} from ${who.padEnd(20)} ${relativeTime(e.queuedAt).padEnd(9)} ${clip(e.body)}`);
    }
  }
  if (bounced.length > 0) {
    console.log(`\nexpired undelivered — ${bounced.length} (never collected):`);
    for (const b of bounced) {
      const who = b.from ? `${b.from}@${b.fromHost}` : b.fromHost;
      console.log(`  → ${b.to.padEnd(14)} from ${who.padEnd(20)} queued ${relativeTime(b.queuedAt)}`);
    }
  }
}
