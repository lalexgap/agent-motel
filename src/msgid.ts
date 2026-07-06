import { randomBytes } from "node:crypto";

// ULID-style message IDs: a 48-bit timestamp prefix (sortable) + 80 bits of
// CSPRNG randomness, Crockford base32. Minted ONCE at the sender and carried
// unchanged through outbox → claim → inject → queue → move, so the receiver can
// dedup redeliveries (at-least-once + dedup, see docs/messaging-redesign.md).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastMs = 0;
let lastRand = new Uint8Array(10);

function encodeTime(ms: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRand(bytes: Uint8Array): string {
  // 80 bits → 16 base32 chars. Treat the 10 bytes as a big-endian integer and
  // peel 5-bit groups off the top.
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.slice(0, 16);
}

// An id stamped at an explicit (usually past) time, bypassing the monotonic
// state — for entries whose order predates "now", e.g. legacy queue migration
// backdating messages to their original enqueue time so the migrated backlog
// sorts ahead of anything appended mid-migration.
export function msgIdAt(ms: number): string {
  return encodeTime(ms) + encodeRand(new Uint8Array(randomBytes(10)));
}

// Mint a new id. Monotonic within a process even if the clock stalls or jumps
// back (same/earlier ms → increment the random tail instead of regenerating),
// so two messages in the same millisecond still sort in send order.
export function newMsgId(now: number = Date.now()): string {
  if (now <= lastMs) {
    for (let i = 9; i >= 0; i--) {
      if (lastRand[i]! < 255) {
        lastRand[i]!++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastMs = now;
    lastRand = new Uint8Array(randomBytes(10));
  }
  return encodeTime(lastMs) + encodeRand(lastRand);
}
