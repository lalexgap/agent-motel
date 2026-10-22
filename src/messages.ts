import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { baseDir, ensureDirs, queueDir } from "./paths";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { withFileLock } from "./filelock";
import { newMsgId } from "./msgid";
import { agentProvider, readAgent, type AgentState } from "./state";
import { locateTranscript, parseTranscript } from "./transcript";
import { hasSession } from "./tmux";
import { queueAppendLocked, queuePopId } from "./queue";
import {
  acquireMailboxLock,
  acquireProducerLock,
  releaseMailboxLock,
  releaseProducerLock,
  withMailboxWrite,
} from "./mailbox";

// Delivery receipts for tracked messages (API sends, `am send --json`).
// Records live in queue/<name>/.messages/, so rename, rm and gc carry them with
// the queue. A queued record's id is also its queue entry's file name
// (`<id>.json`), which is how the delivery paths find it.

export type MessageState = "queued" | "delivered" | "done" | "cancelled" | "failed";

export interface MessageView {
  id: string;
  state: MessageState;
  queuedAt: string;
  deliveredAt: string | null;
  doneAt: string | null;
  transcriptIndex: number | null;
  error?: string;
}

interface MessageRecord extends MessageView {
  // When am began handing the message over: a turn that ends after this is
  // the turn that began with or absorbed it.
  handedAt?: string;
}

// Taken immediately before am hands a message over, so everything the agent
// produces for it lands at index >= transcriptIndex.
export interface DeliveryMark {
  transcriptIndex: number;
  handedAt: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const KEEP_PER_AGENT = 200;
const MAX_AGE_MS = 7 * 86_400_000;

export function isMessageId(id: string): boolean {
  return ID_RE.test(id);
}

function recordsDir(name: string): string {
  return join(queueDir(), name, ".messages");
}

function recordFile(name: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid message id");
  return join(recordsDir(name), `${id}.json`);
}

function recordsLock(name: string): string {
  return join(baseDir(), "locks", `messages.${name}.lock`);
}

function entryMessageId(entryId: string): string {
  return entryId.replace(/\.json$/, "");
}

function view(record: MessageRecord): MessageView {
  const { handedAt: _handedAt, ...rest } = record;
  return rest;
}

function isTerminal(state: MessageState): boolean {
  return state === "done" || state === "cancelled" || state === "failed";
}

function listRecords(name: string): MessageRecord[] {
  const dir = recordsDir(name);
  if (!existsSync(dir)) return [];
  const out: MessageRecord[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const record = readJsonOrNull<MessageRecord>(join(dir, f));
    if (record?.id) out.push(record);
  }
  return out;
}

// Finished records older than a week go, and past the per-agent cap the
// oldest finished ones do. Queued and delivered records are always kept.
function prune(name: string, now: number): void {
  const all = listRecords(name);
  let total = all.length;
  for (const r of all.filter((record) => isTerminal(record.state))) {
    const at = Date.parse(r.doneAt ?? r.deliveredAt ?? r.queuedAt);
    if (total > KEEP_PER_AGENT || !(now - at < MAX_AGE_MS)) {
      rmSync(recordFile(name, r.id), { force: true });
      total--;
    }
  }
}

function createRecord(name: string, record: MessageRecord): void {
  ensureDirs();
  withFileLock(recordsLock(name), () => {
    mkdirSync(recordsDir(name), { recursive: true });
    writeJsonAtomic(recordFile(name, record.id), record, { pretty: false });
    prune(name, Date.now());
  });
}

// Read-modify-write under the records lock. `fn` returns null to leave the
// record as is. A rename can move the directory away underneath a writer
// holding the old name; that write is dropped, as the record moved with it.
function updateRecord(name: string, id: string, fn: (r: MessageRecord) => MessageRecord | null): MessageRecord | null {
  const file = recordFile(name, id);
  if (!existsSync(file)) return null;
  return withFileLock(recordsLock(name), () => {
    const current = readJsonOrNull<MessageRecord>(file);
    if (!current) return null;
    const next = fn(current);
    if (!next) return current;
    try {
      writeJsonAtomic(file, next, { pretty: false });
    } catch {
      return current;
    }
    return next;
  });
}

// The entry count of GET /transcript for this agent right now.
export function transcriptLength(agent: AgentState): number {
  try {
    const file = locateTranscript(agent);
    return parseTranscript(agentProvider(agent), readFileSync(file, "utf8")).turns.length;
  } catch {
    return 0; // no session file yet: nothing has been said
  }
}

function markNow(agent: AgentState | null): DeliveryMark {
  return { transcriptIndex: agent ? transcriptLength(agent) : 0, handedAt: new Date().toISOString() };
}

// Null when the entry has no receipt, so untracked deliveries never pay for a
// transcript parse.
export function deliveryMark(name: string, entryId: string): DeliveryMark | null {
  const id = entryMessageId(entryId);
  if (!ID_RE.test(id) || !existsSync(recordFile(name, id))) return null;
  return markNow(readAgent(name));
}

function turnEndedSince(agent: AgentState, since: string | undefined): boolean {
  if (!since) return false;
  return agent.status === "idle" && Date.parse(agent.statusChangedAt ?? "") > Date.parse(since);
}

// Callers hold the delivery lock and have just popped the entry. A typed
// delivery is confirmed only once the input box clears, by which time a
// short turn may already have ended — then it goes straight to done.
export function markDelivered(name: string, entryId: string, mark?: DeliveryMark | null): void {
  const id = entryMessageId(entryId);
  if (!ID_RE.test(id) || !existsSync(recordFile(name, id))) return;
  const agent = readAgent(name);
  const m = mark ?? markNow(agent);
  const now = new Date().toISOString();
  const ended = agent !== null && turnEndedSince(agent, m.handedAt);
  updateRecord(name, id, (r) =>
    r.state !== "queued"
      ? null
      : {
          ...r,
          state: ended ? "done" : "delivered",
          deliveredAt: now,
          doneAt: ended ? now : null,
          transcriptIndex: m.transcriptIndex,
          handedAt: m.handedAt,
        },
  );
}

// Queue a tracked message: the record lands before the entry, under the
// producer lock, so a deliverer never pops an entry whose record is missing
// and a cancel (which also takes the producer lock) never sees one half made.
export function queueTrackedMessage(name: string, body: string): string {
  return withMailboxWrite(name, () => {
    if (!readAgent(name)) throw new Error(`agent "${name}" no longer exists — retry the message`);
    const id = newMsgId();
    createRecord(name, {
      id,
      state: "queued",
      queuedAt: new Date().toISOString(),
      deliveredAt: null,
      doneAt: null,
      transcriptIndex: null,
    });
    try {
      queueAppendLocked(name, body, undefined, `${id}.json`);
    } catch (error) {
      rmSync(recordFile(name, id), { force: true });
      throw error;
    }
    return id;
  });
}

// For --now and interrupt sends: take the mark before typing, record after.
export function recordImmediateDelivery(name: string, mark: DeliveryMark): string {
  const id = newMsgId();
  const now = new Date().toISOString();
  createRecord(name, {
    id,
    state: "delivered",
    queuedAt: mark.handedAt,
    deliveredAt: now,
    doneAt: null,
    transcriptIndex: mark.transcriptIndex,
    handedAt: mark.handedAt,
  });
  return id;
}

export function immediateMark(agent: AgentState): DeliveryMark {
  return markNow(agent);
}

export function markTurnEnded(name: string, at: Date = new Date()): void {
  const iso = at.toISOString();
  for (const r of listRecords(name)) {
    if (r.state !== "delivered" || !r.handedAt || Date.parse(r.handedAt) > at.getTime()) continue;
    updateRecord(name, r.id, (cur) => (cur.state === "delivered" ? { ...cur, state: "done", doneAt: iso } : null));
  }
}

export function cancelQueuedMessages(name: string): void {
  for (const r of listRecords(name)) {
    if (r.state !== "queued") continue;
    updateRecord(name, r.id, (cur) => (cur.state === "queued" ? { ...cur, state: "cancelled", error: "queue cleared" } : null));
  }
}

// Catch up a record with what the hooks may have missed: a delivered message
// whose turn ended (or whose session died) is done; a queued one whose
// session died is abandoned — taken out of the queue so a later resume can't
// deliver a message its sender was told failed.
function settle(name: string, record: MessageRecord): MessageRecord {
  if (isTerminal(record.state)) return record;
  const agent = readAgent(name);
  const live = agent !== null && hasSession(agent.tmuxSession);
  if (record.state === "delivered") {
    if (live && !turnEndedSince(agent!, record.handedAt)) return record;
    const now = new Date().toISOString();
    return updateRecord(name, record.id, (cur) => (cur.state === "delivered" ? { ...cur, state: "done", doneAt: now } : null)) ?? record;
  }
  if (live) return record;
  // Both locks: no delivery or enqueue of this entry can be in flight.
  if (!acquireMailboxLock(name)) return record;
  try {
    if (!acquireProducerLock(name)) return record;
    try {
      const current = readAgent(name);
      if (current && hasSession(current.tmuxSession)) return record;
      return (
        updateRecord(name, record.id, (cur) => {
          if (cur.state !== "queued") return null;
          queuePopId(name, `${cur.id}.json`);
          return { ...cur, state: "failed", error: "session ended before delivery" };
        }) ?? record
      );
    } finally {
      releaseProducerLock(name);
    }
  } finally {
    releaseMailboxLock(name);
  }
}

export function readMessage(name: string, id: string): MessageView | null {
  if (!ID_RE.test(id)) return null;
  const record = readJsonOrNull<MessageRecord>(recordFile(name, id));
  return record ? view(settle(name, record)) : null;
}

export function settleMessages(name: string): void {
  for (const r of listRecords(name)) settle(name, r);
}

// Callers hold the delivery and producer locks.
export function cancelQueuedLocked(
  name: string,
  id: string,
  inFlight: boolean,
): { ok: true; state: "cancelled" } | { ok: false; error: string; state: MessageState } | null {
  const record = readJsonOrNull<MessageRecord>(recordFile(name, id));
  if (!record) return null;
  if (record.state !== "queued") return { ok: false, error: `message ${id} is already ${record.state}`, state: record.state };
  // Typed into the input box, or sent to the session inbox, awaiting
  // confirmation: the agent may already have it.
  if (inFlight) return { ok: false, error: `message ${id} is being delivered`, state: "queued" };
  queuePopId(name, `${id}.json`);
  updateRecord(name, id, (cur) => (cur.state === "queued" ? { ...cur, state: "cancelled" } : null));
  return { ok: true, state: "cancelled" };
}
