import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { outboxBouncesFile, outboxDir, outboxFile } from "./paths";
import { loadConfig } from "./config";
import { parseJsonl } from "./comms";
import { newMsgId } from "./msgid";

// Store-and-forward messaging for the reverse direction. A send whose target
// can't be reached from here (no local agent, no reachable remote) lands in the
// outbox; a collector on the machine that owns the target name sweeps it out
// over ssh and injects it locally. The transport is the collector's existing
// ssh-to-remotes — the unreachable side never needs to be dialed.

export interface OutboxEntry {
  msgId: string; // stable id minted at send; carried through for dedup on redelivery
  to: string;
  from?: string; // AGENTMGR_AGENT of the sender, if sent from inside an agent
  fromHost: string; // os.hostname() of the sending machine
  body: string; // raw message — attribution is applied at injection time
  queuedAt: string; // ISO
  ttlMs: number; // self-describing so a config change doesn't retro-expire
}

export interface BouncedEntry extends OutboxEntry {
  expiredAt: string;
}

export function isExpired(entry: OutboxEntry, now = Date.now()): boolean {
  return Date.parse(entry.queuedAt) + entry.ttlMs <= now;
}

// The sender label a collected message is attributed with: "<host>:<name>" —
// the canonical fleet address form, so the recipient can reply by pasting it
// straight into `am send`. (Previously "<name>@<host>", which the reply parser
// couldn't route — see docs/messaging-redesign.md.) Falls back to the ssh-alias
// host when the entry carries no fromHost, and to host-only when the send wasn't
// from inside an agent. Host is shortened to its first dns label.
export function collectedSender(from: string | undefined, fromHost: string, fallbackHost: string): string {
  const raw = fromHost || fallbackHost;
  const origin = raw.split(".")[0] || raw;
  return from ? `${origin}:${from}` : origin;
}

function readEntries(file: string): OutboxEntry[] {
  if (!existsSync(file)) return [];
  return parseJsonl<OutboxEntry>(readFileSync(file, "utf8"));
}

export interface AppendInput {
  to: string;
  from?: string;
  fromHost: string;
  body: string;
  ttlMs?: number;
  queuedAt?: string;
  msgId?: string;
}

export function outboxAppend(input: AppendInput): OutboxEntry {
  mkdirSync(outboxDir(), { recursive: true });
  const entry: OutboxEntry = {
    msgId: input.msgId ?? newMsgId(),
    to: input.to,
    from: input.from,
    fromHost: input.fromHost,
    body: input.body,
    queuedAt: input.queuedAt ?? new Date().toISOString(),
    ttlMs: input.ttlMs ?? loadConfig().outboxTtlHours * 60 * 60 * 1000,
  };
  appendFileSync(outboxFile(input.to), JSON.stringify(entry) + "\n");
  return entry;
}

const BOUNCE_CAP = 200;

function recordBounces(expired: OutboxEntry[]): void {
  if (expired.length === 0) return;
  const at = new Date().toISOString();
  const existing = readBounces();
  const all = [...existing, ...expired.map((e) => ({ ...e, expiredAt: at }))];
  const kept = all.slice(-BOUNCE_CAP);
  // tmp+rename so a crash mid-write can't corrupt the bounce log.
  const file = outboxBouncesFile();
  const tmp = file + ".tmp";
  writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  renameSync(tmp, file);
}

export function readBounces(): BouncedEntry[] {
  const file = outboxBouncesFile();
  if (!existsSync(file)) return [];
  return parseJsonl<BouncedEntry>(readFileSync(file, "utf8"));
}

// Atomically return-and-remove all live entries addressed to `names`. Expired
// entries are dropped (recorded as bounces, never returned). Called by the
// collector over ssh.
export function outboxTake(names: string[], now = Date.now()): OutboxEntry[] {
  const live: OutboxEntry[] = [];
  const expired: OutboxEntry[] = [];
  for (const name of names) {
    const file = outboxFile(name);
    if (!existsSync(file)) continue;
    // Rename first so an append racing the take goes to a fresh file (picked up
    // next sweep) rather than being read-then-clobbered.
    const tmp = `${file}.taking`;
    try {
      renameSync(file, tmp);
    } catch {
      continue;
    }
    for (const e of readEntries(tmp)) (isExpired(e, now) ? expired : live).push(e);
    rmSync(tmp, { force: true });
  }
  recordBounces(expired);
  return live;
}

// --- claim / ack / reclaim: redrive-safe pickup (replaces the lossy take) ---
//
// Take deleted entries before the collector had persisted them — a crash in
// between lost mail silently. Instead: CLAIM renames pending → a per-sweep
// `.claimed` file and returns it WITHOUT deleting; the collector injects
// locally, then ACKs (delete). A claim that's never acked (collector crashed)
// is RECLAIMED — its entries return to pending for the next sweep — and dedup
// (msgId) absorbs any double-delivery. See docs/messaging-redesign.md.

const CLAIM_SUFFIX = ".claimed.jsonl";

function claimedPath(name: string, cid: string): string {
  return outboxFile(name).replace(/\.jsonl$/, `.${cid}${CLAIM_SUFFIX}`);
}

// Return stale claims (older than timeoutMs) to the pending outbox. Idempotent;
// folded into outboxClaim so a restarted daemon recovers prior claims for free.
export function outboxReclaim(timeoutMs: number, now = Date.now()): void {
  if (!existsSync(outboxDir())) return;
  for (const f of readdirSync(outboxDir())) {
    if (!f.endsWith(CLAIM_SUFFIX)) continue;
    const file = join(outboxDir(), f);
    let ageMs: number;
    try {
      ageMs = now - statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < timeoutMs) continue;
    for (const e of readEntries(file)) appendFileSync(outboxFile(e.to), JSON.stringify(e) + "\n");
    rmSync(file, { force: true });
  }
}

// Claim live entries for `names` under claim id `cid`: rename to `.claimed`
// (not deleted), drop expired → bounces, return the rest. The collector must
// call outboxAck(cid) once they're durably delivered, else they're reclaimed.
export function outboxClaim(cid: string, names: string[], now = Date.now()): OutboxEntry[] {
  outboxReclaim(2 * 60_000, now); // recover claims abandoned >2min (e.g. a crashed sweep)
  const live: OutboxEntry[] = [];
  const expired: OutboxEntry[] = [];
  for (const name of names) {
    const file = outboxFile(name);
    if (!existsSync(file)) continue;
    const claimed = claimedPath(name, cid);
    try {
      renameSync(file, claimed); // atomic; appends racing the claim land in a fresh file
    } catch {
      continue;
    }
    const here = readEntries(claimed);
    const liveHere = here.filter((e) => !isExpired(e, now));
    const expiredHere = here.filter((e) => isExpired(e, now));
    if (expiredHere.length > 0) {
      // Keep the claimed file holding exactly what was handed out (live only), so
      // ack/reclaim never resurrect an expired entry.
      if (liveHere.length > 0) writeFileSync(claimed, liveHere.map((e) => JSON.stringify(e)).join("\n") + "\n");
      else rmSync(claimed, { force: true });
    }
    live.push(...liveHere);
    expired.push(...expiredHere);
  }
  recordBounces(expired);
  // Per-sender FIFO within a sweep: msgId is time-sortable, so ordering by it
  // restores send order even if entries raced across the claim boundary.
  live.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));
  return live;
}

// Confirm a claim is durably delivered: delete its claimed files.
export function outboxAck(cid: string): void {
  if (!existsSync(outboxDir())) return;
  const tail = `.${cid}${CLAIM_SUFFIX}`;
  for (const f of readdirSync(outboxDir())) {
    if (f.endsWith(tail)) rmSync(join(outboxDir(), f), { force: true });
  }
}

export interface OutboxView {
  live: OutboxEntry[];
  bounced: BouncedEntry[];
}

// Inspect without removing live entries — but still drop expired ones (read is
// when expiry happens). Used by `am outbox`.
export function outboxList(now = Date.now()): OutboxView {
  const live: OutboxEntry[] = [];
  const expired: OutboxEntry[] = [];
  if (existsSync(outboxDir())) {
    for (const f of readdirSync(outboxDir())) {
      if (!f.endsWith(".jsonl") || f.endsWith(CLAIM_SUFFIX)) continue; // skip in-flight claims
      const file = join(outboxDir(), f);
      const entries = readEntries(file);
      const keep = entries.filter((e) => !isExpired(e, now));
      const gone = entries.filter((e) => isExpired(e, now));
      if (gone.length > 0) {
        if (keep.length > 0) writeFileSync(file, keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
        else rmSync(file, { force: true });
        expired.push(...gone);
      }
      live.push(...keep);
    }
  }
  recordBounces(expired);
  return { live, bounced: readBounces() };
}

// Drop everything — pending entries and the bounces log. `am outbox --clear`.
export function outboxClear(): void {
  rmSync(outboxDir(), { recursive: true, force: true });
  rmSync(outboxBouncesFile(), { force: true });
}

// Pull (and clear) the bounces originating from a given sender, so the next
// `am send` from that agent can surface what expired undelivered.
export function takeBouncesFrom(from: string): BouncedEntry[] {
  const all = readBounces();
  const mine = all.filter((b) => b.from === from);
  if (mine.length === 0) return [];
  const rest = all.filter((b) => b.from !== from);
  if (rest.length > 0) writeFileSync(outboxBouncesFile(), rest.map((e) => JSON.stringify(e)).join("\n") + "\n");
  else rmSync(outboxBouncesFile(), { force: true });
  return mine;
}
