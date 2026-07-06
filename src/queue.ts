import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, queueDir } from "./paths";
import { msgIdAt, newMsgId } from "./msgid";
import { parseJsonl } from "./comms";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";

// One directory per agent, one file per message (maildir-style). Appends and
// pops touch different files, so a send can never race a pop into losing a
// message — the old single-JSONL queue rewrote the whole file on pop, and an
// append landing between its read and its rename was silently clobbered.
// File names are msgIds (time-sortable ULIDs), so lexicographic order = FIFO.
//
// Claim suffixes (`.taking.<ms>`, `legacy.migrating.<ms>`) carry their own
// epoch stamp: rename preserves mtime, so an mtime-based staleness check
// would see any message queued >30s ago as instantly stale the moment it was
// claimed — and reclaim it into a duplicate delivery.

interface QueueEntry {
  message: string;
  queuedAt: string;
}

function agentQueueDir(name: string): string {
  return join(queueDir(), name);
}

function legacyQueueFile(name: string): string {
  return join(queueDir(), `${name}.jsonl`);
}

const CLAIM_STALE_MS = 30_000;
const TAKING_RE = /^(.+\.json)\.taking\.(\d+)$/;
const MIGRATING_RE = /^legacy\.migrating\.(\d+)$/;

// Split a claimed legacy file into per-message entries, backdating each to
// its original enqueue time so the migrated backlog sorts (and delivers)
// ahead of anything appended mid-migration by another process.
function adoptLegacy(name: string, file: string): void {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // vanished or unreadable — nothing to adopt
  }
  for (const entry of parseJsonl<QueueEntry>(text)) {
    writeEntry(name, entry, Date.parse(entry.queuedAt) || Date.now());
  }
  rmSync(file, { force: true });
}

// The pre-maildir queue was a single `<name>.jsonl`. Migrate it on first
// touch: rename-first so exactly one process wins the claim and performs the
// split. A claim stranded by a crashed migrator (stale by its name-stamp) is
// adopted here too — entries already split before the crash come back as
// duplicates, but at-least-once beats silently losing the backlog.
function migrateLegacy(name: string): void {
  const dir = agentQueueDir(name);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = MIGRATING_RE.exec(f);
      if (m && Date.now() - Number(m[1]) > CLAIM_STALE_MS) adoptLegacy(name, join(dir, f));
    }
  }
  const legacy = legacyQueueFile(name);
  if (!existsSync(legacy)) return;
  mkdirSync(dir, { recursive: true });
  const claimed = join(dir, `legacy.migrating.${Date.now()}`);
  try {
    renameSync(legacy, claimed);
  } catch {
    return; // another process claimed the migration
  }
  adoptLegacy(name, claimed);
}

// Atomic write via tmp+rename, so a reader never sees a half-written message.
function writeEntry(name: string, entry: QueueEntry, atMs?: number): void {
  const dir = agentQueueDir(name);
  mkdirSync(dir, { recursive: true });
  const id = atMs === undefined ? newMsgId() : msgIdAt(atMs);
  writeJsonAtomic(join(dir, `${id}.json`), entry, { pretty: false });
}

// FIFO-ordered message files. The single chokepoint for reads: legacy
// migration and stale-claim recovery both happen here, so every read path
// (list/depth/head/pop) sees the same repaired view.
function entryFiles(name: string): string[] {
  migrateLegacy(name);
  const dir = agentQueueDir(name);
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json")) {
      names.push(f);
      continue;
    }
    // Reclaim a claim whose popper crashed mid-pop (stale by its name-stamp)
    // so the message is redelivered instead of stranded.
    const m = TAKING_RE.exec(f);
    if (m && Date.now() - Number(m[2]) > CLAIM_STALE_MS) {
      try {
        renameSync(join(dir, f), join(dir, m[1]!));
        names.push(m[1]!);
      } catch {
        // raced another reclaimer
      }
    }
  }
  return names.sort();
}

export function queueAppend(name: string, message: string): void {
  ensureDirs();
  migrateLegacy(name); // the legacy backlog must land first to keep FIFO
  writeEntry(name, { message, queuedAt: new Date().toISOString() });
}

export function queueList(name: string): QueueEntry[] {
  const dir = agentQueueDir(name);
  const out: QueueEntry[] = [];
  for (const f of entryFiles(name)) {
    const entry = readJsonOrNull<QueueEntry>(join(dir, f));
    if (entry) out.push(entry);
  }
  return out;
}

export function queueDepth(name: string): number {
  return entryFiles(name).length;
}

export function queuePeek(name: string): string | null {
  return queueHead(name)?.message ?? null;
}

export interface QueueHead {
  id: string;
  message: string;
}

// The head entry with its file id, so a deliverer can later remove exactly
// what it peeked (queuePopId) — popping "the current head" instead could
// delete a different message that got reclaimed in between.
export function queueHead(name: string): QueueHead | null {
  const dir = agentQueueDir(name);
  for (const f of entryFiles(name)) {
    const entry = readJsonOrNull<QueueEntry>(join(dir, f));
    if (entry) return { id: f, message: entry.message };
  }
  return null;
}

// Remove one specific entry (by the id queueHead returned). Missing file =
// someone else already took it — fine either way, it must not be delivered
// again by this caller.
export function queuePopId(name: string, id: string): void {
  rmSync(join(agentQueueDir(name), id), { force: true });
}

export function queuePop(name: string): string | null {
  const dir = agentQueueDir(name);
  for (const f of entryFiles(name)) {
    const file = join(dir, f);
    const claimed = `${file}.taking.${Date.now()}`;
    try {
      renameSync(file, claimed); // atomic claim — a racing popper loses and moves on
    } catch {
      continue;
    }
    const entry = readJsonOrNull<QueueEntry>(claimed);
    rmSync(claimed, { force: true });
    if (entry) return entry.message;
    // corrupt entry — dropped; try the next one
  }
  return null;
}

export function queueClear(name: string): void {
  rmSync(legacyQueueFile(name), { force: true });
  rmSync(agentQueueDir(name), { recursive: true, force: true });
}
