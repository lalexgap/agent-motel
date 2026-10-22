import { createHash } from "node:crypto";
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
  // On a done record: its turn was aborted with Esc rather than finished.
  interrupted?: true;
}

// Why a message or interrupt route refused (HTTP 409), for clients to branch
// on without parsing `error`.
export type ConflictReason =
  | "not_delivered"
  | "already_done"
  | "already_cancelled"
  | "already_failed"
  | "not_started"
  | "already_interrupted"
  | "no_session"
  | "mailbox_busy"
  | "already_delivered"
  | "remote_too_old"
  | "unknown";

export type Conflict = { ok: false; error: string; state: MessageState; reason: ConflictReason };

export function alreadyReason(state: Exclude<MessageState, "queued">): ConflictReason {
  return `already_${state}`;
}

// The reason for a refusal that arrives as an error message: a local throw,
// or a remote am's stderr. Undefined when the message is none of these.
export function conflictReason(message: string): ConflictReason | undefined {
  if (/remote am too old|unknown command/.test(message)) return "remote_too_old";
  if (/mailbox is busy/.test(message)) return "mailbox_busy";
  if (/has no live tmux session|no longer exists|no agent matches|no local agent/.test(message)) return "no_session";
  if (/is being delivered/.test(message)) return "already_delivered";
  if (/is not delivered yet/.test(message)) return "not_delivered";
  if (/has not started yet/.test(message)) return "not_started";
  if (/was already interrupted/.test(message)) return "already_interrupted";
  const already = /is already (delivered|done|cancelled|failed)\b/.exec(message);
  return already ? alreadyReason(already[1] as Exclude<MessageState, "queued">) : undefined;
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
  promptKey?: string;
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
  const { handedAt: _handedAt, via: _via, startedAt: _startedAt, interruptedAt: _interruptedAt, promptKey: _promptKey, ...rest } = record;
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

type TurnFields = Pick<MessageRecord, "handedAt" | "via" | "startedAt" | "promptKey">;

// Whether a turn ending at `end` is one that handled this message: one it
// was absorbed into, or one its own claimed prompt started. Records from
// before claims existed (no `via` or `promptKey`) take any prompt since the
// handover.
function completesAt(r: TurnFields, agent: AgentState, end: number): boolean {
  if (!r.handedAt) return false;
  const handed = Date.parse(r.handedAt);
  if (!(handed <= end)) return false;
  if (r.via === "absorbed") return true;
  if (r.via === undefined || r.promptKey === undefined) return after(agent.promptAt, handed);
  return r.startedAt !== undefined && Date.parse(r.startedAt) < end;
}

function turnEndedSince(agent: AgentState, r: TurnFields): boolean {
  if (!r.handedAt || agent.status !== "idle" || !after(agent.statusChangedAt, Date.parse(r.handedAt))) return false;
  return completesAt(r, agent, Date.parse(agent.statusChangedAt!));
}

// Claude Code hands a long paste to UserPromptSubmit wrapped in these tags.
const PASTE_TAG_RE = /<\/?pasted_content id="[^"]*">/g;

// Matches a UserPromptSubmit to the message it submits without storing the
// message text.
export function promptKey(text: string): string {
  return createHash("sha256").update(text.replace(PASTE_TAG_RE, " ").replace(/\s+/g, " ").trim()).digest("hex");
}

const promptHeld = (records: MessageRecord[], promptAt: string) =>
  records.some((r) => r.via === "prompt" && r.startedAt === promptAt);

const byHandover = (a: MessageRecord, b: MessageRecord) =>
  Date.parse(a.handedAt!) - Date.parse(b.handedAt!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// A UserPromptSubmit whose text is a delivered message's starts that
// message's turn: a re-submission (Claude puts a prompt back and submits it
// again) moves the running one's start, otherwise the oldest unstarted one
// with that text starts. A prompt matching no message starts none.
export function claimPrompt(name: string, promptAt: string, key: string): string | null {
  if (!existsSync(recordsDir(name))) return null;
  return withFileLock(recordsLock(name), () => {
    const records = listRecords(name);
    if (promptHeld(records, promptAt)) return null;
    const at = Date.parse(promptAt);
    const matching = records.filter((r) => r.state === "delivered" && r.via === "prompt" && r.promptKey === key);
    const running = matching.filter((r) => r.startedAt).sort((a, b) => Date.parse(b.startedAt!) - Date.parse(a.startedAt!))[0];
    const next = running ?? matching.filter((r) => !r.startedAt && Date.parse(r.handedAt ?? "") < at).sort(byHandover)[0];
    if (!next) return null;
    writeJsonAtomic(recordFile(name, next.id), { ...next, startedAt: promptAt }, { pretty: false });
    return next.id;
  });
}

function claimFor(name: string, id: string, promptAt: string): void {
  withFileLock(recordsLock(name), () => {
    if (promptHeld(listRecords(name), promptAt)) return;
    const file = recordFile(name, id);
    const record = readJsonOrNull<MessageRecord>(file);
    if (record?.state === "delivered" && !record.startedAt) writeJsonAtomic(file, { ...record, startedAt: promptAt }, { pretty: false });
  });
}

// A delivery can be confirmed after its UserPromptSubmit already fired, and
// even after a short turn ended: claim that prompt now, then settle.
// `confirmedBy`: the prompt that confirmed an inbox delivery, which wraps the
// message, so its text doesn't match.
function afterHandover(name: string, id: string, confirmedBy?: string): void {
  const agent = readAgent(name);
  if (!agent) return;
  const record = readJsonOrNull<MessageRecord>(recordFile(name, id));
  if (record?.state !== "delivered") return;
  if (record.via === "prompt" && !record.startedAt) {
    const late = agent.promptAt && record.promptKey && agent.promptKey === record.promptKey
      && after(agent.promptAt, Date.parse(record.handedAt ?? ""));
    const by = confirmedBy ?? (late ? agent.promptAt : undefined);
    if (by) claimFor(name, id, by);
  }
  const now = new Date().toISOString();
  updateRecord(name, id, (cur) => (cur.state === "delivered" && turnEndedSince(agent, cur) ? { ...cur, state: "done", doneAt: now } : null));
}

// Callers hold the delivery lock and have just popped the entry.
export function markDelivered(
  name: string,
  entryId: string,
  mark?: DeliveryMark | null,
  via: DeliveryVia = "prompt",
  confirmedBy?: string,
): void {
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
  afterHandover(name, id, confirmedBy);
}

// A delivered message the agent never started, taken back to be handed over
// again: queued as it was before its handover. Callers hold the delivery lock.
export function requeueDelivered(name: string, entryId: string): void {
  const id = entryMessageId(entryId);
  if (!ID_RE.test(id) || !existsSync(recordFile(name, id))) return;
  updateRecord(name, id, (r) => {
    if (r.state !== "delivered" || r.startedAt) return null;
    const { handedAt: _h, via: _v, interruptedAt: _i, interrupted: _x, ...rest } = r;
    return { ...rest, state: "queued", deliveredAt: null, doneAt: null, transcriptIndex: null };
  });
}

// Whether an entry taken back from Codex may go back in am's queue: its
// record, if it has one, shows it handed over and not started.
export function entryUnstarted(name: string, entryId: string): boolean {
  const id = entryMessageId(entryId);
  if (!ID_RE.test(id)) return false;
  const r = readJsonOrNull<MessageRecord>(recordFile(name, id));
  return !r || (r.state === "delivered" && !r.startedAt);
}

// Prompts an Esc now may abort whose UserPromptSubmit hook hasn't run yet:
// handed over as prompts since the agent's last prompt, and not started.
export function lateHookKeys(name: string, agent: AgentState): string[] {
  const since = Date.parse(agent.promptAt ?? "") || 0;
  return listRecords(name)
    .filter((r) => r.state === "delivered" && r.via === "prompt" && !r.startedAt && r.promptKey && Date.parse(r.handedAt ?? "") > since)
    .map((r) => r.promptKey!);
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
      promptKey: promptKey(body),
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
export function recordImmediateDelivery(name: string, mark: DeliveryMark, body: string, via: DeliveryVia = "prompt"): string {
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
    promptKey: promptKey(body),
    ...(via === "absorbed" ? { startedAt: mark.handedAt } : {}),
  });
  afterHandover(name, id);
  return id;
}

export function immediateMark(agent: AgentState): DeliveryMark {
  return markNow(agent);
}

export function markTurnEnded(name: string, agent: AgentState, at: Date = new Date(), interrupted = false): void {
  const iso = at.toISOString();
  for (const r of listRecords(name)) {
    if (r.state !== "delivered" || !completesAt(r, agent, at.getTime())) continue;
    updateRecord(name, r.id, (cur) =>
      cur.state === "delivered" ? { ...cur, state: "done", doneAt: iso, ...(interrupted ? { interrupted: true as const } : {}) } : null,
    );
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
): { ok: true; state: "cancelled" } | Conflict | null {
  const record = readJsonOrNull<MessageRecord>(recordFile(name, id));
  if (!record) return null;
  if (record.state !== "queued") {
    return { ok: false, error: `message ${id} is already ${record.state}`, state: record.state, reason: alreadyReason(record.state) };
  }
  // Typed into the input box, or sent to the session inbox, awaiting
  // confirmation: the agent may already have it.
  if (inFlight) return { ok: false, error: `message ${id} is being delivered`, state: "queued", reason: "already_delivered" };
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
