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
import { withMailboxWrite } from "./mailbox";

// Delivery receipts for tracked messages (API sends, `am send --json`).
// Records live in queue/<name>/.messages/, so rename, rm and gc carry them with
// the queue. A queued record's id is also its queue entry's file name
// (`<id>.json`), which is how the delivery paths find it. A queued record
// waits out a stopped session, as its entry does, for a resume to deliver it.

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

// How the agent got the message: as a prompt (a new turn's, or one Claude
// takes in mid-turn, either way firing UserPromptSubmit), or absorbed into the
// running turn by a hook. Records without it are prompts.
export type DeliveryVia = "prompt" | "absorbed";

export interface MessageRecord extends MessageView {
  // When am began handing the message over.
  handedAt?: string;
  via?: DeliveryVia;
  // The prompt (UserPromptSubmit) that started its turn; see claimPrompt.
  startedAt?: string;
  interruptedAt?: string;
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
  const { handedAt: _handedAt, via: _via, startedAt: _startedAt, interruptedAt: _interruptedAt, ...rest } = record;
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

const after = (at: string | undefined, since: number) => Date.parse(at ?? "") > since;

type TurnFields = Pick<MessageRecord, "handedAt" | "via" | "startedAt">;

// Whether a turn ending at `end` is one that handled this message: one it
// was absorbed into, or one its own claimed prompt started. Records from
// before claims existed (no `via`) take any prompt since the handover.
function completesAt(r: TurnFields, agent: AgentState, end: number): boolean {
  if (!r.handedAt) return false;
  const handed = Date.parse(r.handedAt);
  if (!(handed <= end)) return false;
  if (r.via === "absorbed") return true;
  if (r.via === undefined) return after(agent.promptAt, handed);
  return r.startedAt !== undefined && Date.parse(r.startedAt) < end;
}

function turnEndedSince(agent: AgentState, r: TurnFields): boolean {
  if (!r.handedAt || agent.status !== "idle" || !after(agent.statusChangedAt, Date.parse(r.handedAt))) return false;
  return completesAt(r, agent, Date.parse(agent.statusChangedAt!));
}

// Each UserPromptSubmit starts the turn of at most one prompt delivery: the
// oldest delivered one handed over before it and not yet started. A queue of
// prompts (Codex's thread queue) thus starts in order. Claude can fire
// UserPromptSubmit twice for one prompt it puts back and resubmits, which
// starts one more message early; that message then finishes a turn early.
export function claimPrompt(name: string, promptAt: string): string | null {
  if (!existsSync(recordsDir(name))) return null;
  return withFileLock(recordsLock(name), () => {
    const records = listRecords(name);
    if (records.some((r) => r.via === "prompt" && r.startedAt === promptAt)) return null;
    const at = Date.parse(promptAt);
    const next = records
      .filter((r) => r.state === "delivered" && r.via === "prompt" && !r.startedAt && Date.parse(r.handedAt ?? "") < at)
      .sort((a, b) => Date.parse(a.handedAt!) - Date.parse(b.handedAt!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (!next) return null;
    writeJsonAtomic(recordFile(name, next.id), { ...next, startedAt: promptAt }, { pretty: false });
    return next.id;
  });
}

// A delivery can be confirmed after its UserPromptSubmit already fired, and
// even after a short turn ended: claim that prompt now, then settle.
function afterHandover(name: string, id: string): void {
  const agent = readAgent(name);
  if (!agent) return;
  const record = readJsonOrNull<MessageRecord>(recordFile(name, id));
  if (record?.state !== "delivered") return;
  if (record.via === "prompt" && !record.startedAt && agent.promptAt && after(agent.promptAt, Date.parse(record.handedAt ?? ""))) {
    claimPrompt(name, agent.promptAt);
  }
  const now = new Date().toISOString();
  updateRecord(name, id, (cur) => (cur.state === "delivered" && turnEndedSince(agent, cur) ? { ...cur, state: "done", doneAt: now } : null));
}

// Callers hold the delivery lock and have just popped the entry.
export function markDelivered(name: string, entryId: string, mark?: DeliveryMark | null, via: DeliveryVia = "prompt"): void {
  const id = entryMessageId(entryId);
  if (!ID_RE.test(id) || !existsSync(recordFile(name, id))) return;
  const m = mark ?? markNow(readAgent(name));
  const now = new Date().toISOString();
  updateRecord(name, id, (r) =>
    r.state !== "queued"
      ? null
      : {
          ...r,
          state: "delivered",
          deliveredAt: now,
          doneAt: null,
          transcriptIndex: m.transcriptIndex,
          handedAt: m.handedAt,
          via,
          ...(via === "absorbed" ? { startedAt: m.handedAt } : {}),
        },
  );
  afterHandover(name, id);
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
export function recordImmediateDelivery(name: string, mark: DeliveryMark, via: DeliveryVia = "prompt"): string {
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
    via,
    ...(via === "absorbed" ? { startedAt: mark.handedAt } : {}),
  });
  afterHandover(name, id);
  return id;
}

export function immediateMark(agent: AgentState): DeliveryMark {
  return markNow(agent);
}

export function markTurnEnded(name: string, agent: AgentState, at: Date = new Date()): void {
  const iso = at.toISOString();
  for (const r of listRecords(name)) {
    if (r.state !== "delivered" || !completesAt(r, agent, at.getTime())) continue;
    updateRecord(name, r.id, (cur) => (cur.state === "delivered" ? { ...cur, state: "done", doneAt: iso } : null));
  }
}

const SESSION_ENDED = "session ended before the turn finished";

// The session is gone: a delivered message is done only if a turn that ended
// at `lastEnd` handled it; otherwise it never will be.
function finishDelivered(name: string, id: string, agent: AgentState | null, lastEnd: string | undefined): MessageRecord | null {
  const now = new Date().toISOString();
  return updateRecord(name, id, (cur) => {
    if (cur.state !== "delivered") return null;
    return agent && lastEnd && completesAt(cur, agent, Date.parse(lastEnd))
      ? { ...cur, state: "done", doneAt: now }
      : { ...cur, state: "failed", error: SESSION_ENDED };
  });
}

// `lastEnd`: when the agent went idle, if it was idle as its session ended.
export function markSessionEnded(name: string, agent: AgentState, lastEnd: string | undefined): void {
  for (const r of listRecords(name)) {
    if (r.state === "delivered") finishDelivered(name, r.id, agent, lastEnd);
  }
}

// Catch up a delivered record with a turn end or session death the hooks
// missed. Queued records are left for a resume to deliver.
function settle(name: string, record: MessageRecord): MessageRecord {
  if (record.state !== "delivered") return record;
  const agent = readAgent(name);
  if (agent && turnEndedSince(agent, record)) {
    const now = new Date().toISOString();
    return updateRecord(name, record.id, (cur) => (cur.state === "delivered" ? { ...cur, state: "done", doneAt: now } : null)) ?? record;
  }
  if (agent && hasSession(agent.tmuxSession)) return record;
  return finishDelivered(name, record.id, agent, undefined) ?? record;
}

// Runs `fn` under the records lock on a record caught up with any turn end
// the hooks have yet to mark, so none can land between its check and its
// action; `save` writes it back. Null: no such record.
export function withSettledRecord<T>(
  name: string,
  id: string,
  fn: (record: MessageRecord, save: (next: MessageRecord) => void) => T,
): T | null {
  if (!ID_RE.test(id)) return null;
  const file = recordFile(name, id);
  if (!existsSync(file)) return null;
  return withFileLock(recordsLock(name), () => {
    let record = readJsonOrNull<MessageRecord>(file);
    if (!record) return null;
    const agent = readAgent(name);
    if (record.state === "delivered" && agent && turnEndedSince(agent, record)) {
      record = { ...record, state: "done", doneAt: new Date().toISOString() };
      writeJsonAtomic(file, record, { pretty: false });
    }
    return fn(record, (next) => writeJsonAtomic(file, next, { pretty: false }));
  });
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

// Callers hold the delivery and producer locks and remove the entries next.
// The in-flight entry may already be with the agent, so it is not cancelled.
export function clearQueuedLocked(name: string, inFlightEntryId: string | null): void {
  for (const r of listRecords(name)) {
    if (r.state !== "queued") continue;
    const inFlight = inFlightEntryId === `${r.id}.json`;
    updateRecord(name, r.id, (cur) =>
      cur.state !== "queued"
        ? null
        : inFlight
          ? { ...cur, state: "failed", error: "queue cleared during an unconfirmed delivery" }
          : { ...cur, state: "cancelled", error: "queue cleared" },
    );
  }
}
