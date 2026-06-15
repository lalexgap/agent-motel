import { outboxAck, outboxClaim, outboxClear, outboxList, outboxTake } from "../outbox";
import { relativeTime } from "./ls";

function clip(body: string, max = 50): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// `am __outbox-take <names...>`: atomically return-and-remove live entries for
// those names as JSON. Internal (the collector's ssh pickup) — `__`-prefixed so
// it's hidden and never fleet-forwarded. Kept for collectors that predate the
// claim/ack protocol below.
export function outboxTakeCommand(names: string[]): void {
  console.log(JSON.stringify(outboxTake(names)));
}

// `am __outbox-claim <cid> <names...>`: return live entries as JSON WITHOUT
// deleting them (renamed to a `.claimed` file). The collector must `__outbox-ack
// <cid>` once they're durably delivered, else they're reclaimed and redelivered.
export function outboxClaimCommand(cid: string, names: string[]): void {
  console.log(JSON.stringify(outboxClaim(cid, names)));
}

// `am __outbox-ack <cid>`: confirm a claim is delivered — delete its files.
export function outboxAckCommand(cid: string): void {
  outboxAck(cid);
}

// `am outbox [--clear]`: human inspection of what's queued here for pickup, plus
// anything that expired undelivered. Reading is also when expiry happens.
export function outboxCommand(opts: { clear?: boolean }): void {
  if (opts.clear) {
    outboxClear();
    console.log("outbox cleared");
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
