import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { outboxBouncesFile, outboxDir, outboxFile } from "./paths";
import { loadConfig } from "./config";

// Store-and-forward messaging for the reverse direction. A send whose target
// can't be reached from here (no local agent, no reachable remote) lands in the
// outbox; a collector on the machine that owns the target name sweeps it out
// over ssh and injects it locally. The transport is the collector's existing
// ssh-to-remotes — the unreachable side never needs to be dialed.

export interface OutboxEntry {
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

// The sender label a collected message is attributed with: "<name>@<host>" so
// the recipient knows it crossed machines (and can reply). Falls back to the
// ssh-alias host when the entry carries no fromHost, and to host-only when the
// send wasn't from inside an agent. Host is shortened to its first dns label.
export function collectedSender(from: string | undefined, fromHost: string, fallbackHost: string): string {
  const raw = fromHost || fallbackHost;
  const origin = raw.split(".")[0] || raw;
  return from ? `${from}@${origin}` : origin;
}

function readEntries(file: string): OutboxEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as OutboxEntry);
}

export interface AppendInput {
  to: string;
  from?: string;
  fromHost: string;
  body: string;
  ttlMs?: number;
  queuedAt?: string;
}

export function outboxAppend(input: AppendInput): OutboxEntry {
  mkdirSync(outboxDir(), { recursive: true });
  const entry: OutboxEntry = {
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
  writeFileSync(outboxBouncesFile(), kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function readBounces(): BouncedEntry[] {
  const file = outboxBouncesFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as BouncedEntry);
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
      if (!f.endsWith(".jsonl")) continue;
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
