import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, agentSessionId, readAgent, updateAgentIf, updateAgentStatus, type AgentState, type Provider } from "./state";
import { queueClearEntries, queueDepth, queueHead, queuePopId, queueRestoreLocked } from "./queue";
import { capturePane, hasSession, sendClearLine, sendEnter, sendEscape, sendText, stripFaint, stripSgr, tmux } from "./tmux";
import { cliEntrypoint } from "./settings";
import { baseDir, DAEMON_LOG_MAX_BYTES, daemonLogFile, queueDir } from "./paths";
import { withFileLock } from "./filelock";
import { openLogFd, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { isAttributedBody, operatorEnvelope } from "./comms";
import { peerSendable, peerTarget, sendPeerMessage } from "./claudePeer";
import { clientMessageId, CodexOutcomeUnknown, queueCodexMessage, reclaimCodexMessages } from "./codexQueue";
import {
  acquireMailboxLock,
  acquireProducerLock,
  beginHandoff,
  endHandoff,
  mailboxLockPath,
  releaseMailboxLock,
  releaseProducerLock,
  renewHandoff,
} from "./mailbox";
import {
  alreadyReason,
  cancelQueuedLocked,
  clearQueuedLocked,
  deliveryMark,
  entryUnstarted,
  isMessageId,
  lateHookKeys,
  markDelivered,
  markTurnEnded,
  promptKey,
  readMessage,
  requeueDelivered,
  withSettledRecord,
  type Conflict,
  type DeliveryMark,
  type MessageState,
} from "./messages";

// Keep the lock inode in place: unlinking it would let another process lock a
// new inode while the current holder is still delivering. The kernel releases
// flock automatically if a holder crashes.
export function acquireDeliverLock(name: string): boolean {
  return acquireMailboxLock(name);
}

export function releaseDeliverLock(name: string): void {
  releaseMailboxLock(name);
}

// The exporter exits before a pull finishes, so its ingestion barrier must
// outlive that process. Only the matching handoff can release it.
export function beginDeliveryHandoff(name: string, token: string): void {
  beginHandoff(name, token);
}

export function endDeliveryHandoff(name: string, token: string): boolean {
  return endHandoff(name, token);
}

export function renewDeliveryHandoff(name: string, token: string): boolean { return renewHandoff(name, token); }

export { mailboxLockPath as __lockPath };

export function enterDelayMs(agent: AgentState, message?: string): number | undefined {
  // Codex always drops an Enter that lands in the same key batch as the
  // text; Claude Code does the same intermittently for MULTI-LINE sends
  // (bracketed-paste detection) — the migration briefs are exactly that.
  if (agentProvider(agent) === "codex") {
    const length = message?.length ?? 0;
    const lines = message?.split("\n").length ?? 1;
    return Math.min(2000, 300 + Math.ceil(length / 100) * 20 + (lines - 1) * 20);
  }
  if (message?.includes("\n")) return 200;
  return undefined;
}

// Claude displays a dim `Try "..."` placeholder inside its bordered composer.
const PLACEHOLDER_RE = /^Try "/;

// Needs a colored capture so faint suggestions aren't read as drafts.
export function parsedInputBoxText(pane: string[], provider: Provider = "claude"): string | null {
  const plain = pane.map(stripSgr);
  const typed = pane.map(line => stripSgr(stripFaint(line)));
  if (provider === "codex") {
    // Long composers hide the shortcuts row and scroll the message's head away.
    let footer = -1;
    for (let i = 0; i < plain.length; i++) {
      if (/^\s+\S.*[·•]\s+(?:~?\/|[A-Za-z]:\\)/.test(plain[i]!)) footer = i;
    }
    if (footer < 0) return null;
    let prompt = -1;
    for (let i = 0; i < footer; i++) if (/^\s*›(?:\s|$)/.test(plain[i]!)) prompt = i;
    if (prompt < 0) return null;
    const text = typed.slice(prompt, footer)
      .map(line => line.replace(/\s{2,}[↑↓]\s*$/, ""))
      .join(" ")
      .replace(/^\s*›\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    return text === "Ask Codex to do anything" ? "" : text;
  }
  const seps: number[] = [];
  for (let i = 0; i < plain.length; i++) if (/─{8,}/.test(plain[i]!)) seps.push(i);
  if (seps.length < 2) return null;
  const text = typed
    .slice(seps[seps.length - 2]! + 1, seps[seps.length - 1]!)
    .join(" ")
    .replace(/❯/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return PLACEHOLDER_RE.test(text) ? "" : text;
}

const RUNNING_RE = /esc to interrupt/;

// Whether the TUI shows a turn running, from the hint beside its composer:
// Claude's footer under it, or the status line just above it (Codex, and
// older Claude). Transcript text further up the pane can't pass for it.
export function turnRunning(pane: string[], provider: Provider = "claude"): boolean {
  const plain = pane.map(stripSgr);
  if (provider === "codex") {
    let prompt = -1;
    for (let i = 0; i < plain.length; i++) if (/^\s*›(?:\s|$)/.test(plain[i]!)) prompt = i;
    return prompt >= 0 && plain.slice(Math.max(0, prompt - 5), prompt).some(line => RUNNING_RE.test(line));
  }
  const seps: number[] = [];
  for (let i = 0; i < plain.length; i++) if (/─{8,}/.test(plain[i]!)) seps.push(i);
  if (seps.length < 2) return false;
  const top = seps[seps.length - 2]!;
  return plain.slice(Math.max(0, top - 3), top).concat(plain.slice(seps[seps.length - 1]! + 1)).some(line => RUNNING_RE.test(line));
}

export function inputBoxText(pane: string[], provider: Provider = "claude"): string {
  return parsedInputBoxText(pane, provider) ?? "";
}

export function looksUnsubmitted(pane: string[], message: string, provider: Provider = "claude"): boolean {
  const input = inputBoxText(pane, provider);
  if (!input) return false;
  const normalized = message.replace(/\s+/g, " ").trim();
  return provider === "codex"
    ? normalized.includes(input.slice(0, 24))
    : input.includes(normalized.slice(0, 24));
}

const SUBMIT_RETRIES = 2;
const SUBMIT_CHECK_MS = 600;

export type DeliveryResult =
  | { status: "submitted"; id: string }
  | { status: "queued"; reason: "unavailable" | "locked" | "empty" | "composing" | "unverified" };

// The marker records which queued message we typed. If Enter is swallowed,
// later attempts press Enter again instead of appending the text a second time.
// An inbox marker records a frame sent to Claude's session socket, awaiting
// the UserPromptSubmit hook's confirmation.
interface PendingDelivery {
  id: string;
  message: string;
  typed?: boolean;
  incarnation?: string;
  via?: "inbox";
  sentAt?: number;
  // The exact inbox text, and for operator messages the tag the hook verifies.
  content?: string;
  operatorTag?: string;
  inboxFailed?: boolean;
  mark?: DeliveryMark;
}

const INBOX_CONFIRM_MS = 5000;
const INBOX_RETRY_MS = 30_000;

function pendingPath(name: string): string {
  return join(queueDir(), name, ".delivery.pending");
}

function confirmedPath(name: string): string {
  return join(queueDir(), name, ".delivery.confirmed");
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// UserPromptSubmit: the prompt carrying the in-flight inbox message is the
// acknowledgement that the turn really started. Lock-free, because the
// deliverer holds the lock while it waits for exactly this. `promptAt` is the
// prompt's start, which the delivery's receipt claims. Returns the operator
// tag when the confirmed message is the operator's, so the hook can vouch for it.
export function confirmInboxDelivery(name: string, prompt: string, promptAt?: string): string | null {
  const inbox = inboxDeliveryIn(name, prompt);
  if (!inbox) return null;
  writeJsonAtomic(confirmedPath(name), { id: inbox.id, promptAt });
  return inbox.operatorTag ?? null;
}

// The in-flight inbox delivery this prompt carries, if any: `content` is the
// text am sent, inside whatever framing Claude adds. Pure read.
export function inboxDeliveryIn(name: string, prompt: string): { id: string; content: string; operatorTag?: string } | null {
  const pending = readJsonOrNull<PendingDelivery>(pendingPath(name));
  // Markers written before `content` existed came only from peer sends, whose content was the message itself.
  const content = pending?.content ?? (pending && isAttributedBody(pending.message) ? pending.message : null);
  if (pending?.via !== "inbox" || !content || !normalized(prompt).includes(normalized(content))) return null;
  return { id: pending.id, content, operatorTag: pending.operatorTag };
}

function deliveryConfirmed(name: string, id: string): boolean {
  return readJsonOrNull<{ id?: string }>(confirmedPath(name))?.id === id;
}

function finishDelivery(name: string, id: string): void {
  const pending = readJsonOrNull<PendingDelivery>(pendingPath(name));
  const confirmed = readJsonOrNull<{ id?: string; promptAt?: string }>(confirmedPath(name));
  queuePopId(name, id);
  try {
    markDelivered(name, id, pending?.id === id ? pending.mark : undefined, "prompt", confirmed?.id === id ? confirmed.promptAt : undefined);
  } catch {
    // a receipt must not undo a delivery
  }
  rmSync(pendingPath(name), { force: true });
  rmSync(confirmedPath(name), { force: true });
}

// For drains holding the delivery lock: retire an inbox message the agent
// already received, so it is neither surfaced again nor left blocking the queue.
export function finishConfirmedDelivery(name: string, id: string): boolean {
  if (!deliveryConfirmed(name, id)) return false;
  finishDelivery(name, id);
  return true;
}

function sessionIncarnation(agent: AgentState): string | null {
  const result = tmux("display-message", "-p", "-t", `=${agent.tmuxSession}`, "#{pid}:#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}");
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  return JSON.stringify([agentProvider(agent), result.stdout.trim()]);
}

export function pendingDeliveryId(name: string): string | null {
  const pending = readJsonOrNull<PendingDelivery>(pendingPath(name));
  const agent = readAgent(name);
  if (!pending) return null;
  const incarnation = agent ? sessionIncarnation(agent) : null;
  // Older markers and an unreadable session remain deferred until delivery can retry.
  return !pending.incarnation || !incarnation || pending.incarnation === incarnation ? pending.id : null;
}

export async function deliverNext(name: string): Promise<DeliveryResult> {
  if (!acquireDeliverLock(name)) return { status: "queued", reason: "locked" };
  try {
    const agent = readAgent(name);
    if (!agent || !hasSession(agent.tmuxSession)) return { status: "queued", reason: "unavailable" };
    const incarnation = sessionIncarnation(agent);
    if (!incarnation) return { status: "queued", reason: "unavailable" };
    const provider = agentProvider(agent);
    // A reclaim cut short left a message to take back; settle it before
    // anything queued behind it goes out.
    if (provider === "codex" && needsCodexRecovery(name)) await reclaimCodexHandoffs(name, agent, true);
    const head = queueHead(name);
    if (head === null) return { status: "queued", reason: "empty" };
    const markerPath = pendingPath(name);
    const marker = readJsonOrNull<PendingDelivery>(markerPath);
    let pending = marker?.incarnation === incarnation ? marker : null;

    if (pending?.id === head.id && pending.via === "inbox") {
      if (deliveryConfirmed(name, head.id)) {
        finishDelivery(name, head.id);
        return { status: "submitted", id: head.id };
      }
      if (Date.now() - (pending.sentAt ?? 0) < INBOX_RETRY_MS) return { status: "queued", reason: "unverified" };
      // Never confirmed: type it instead, and don't loop back to the inbox.
      pending = { id: head.id, message: head.message, incarnation, inboxFailed: true };
      writeJsonAtomic(markerPath, pending);
    }
    const inbox = pending?.id === head.id ? null : inboxSender(agent, head);
    if (inbox) {
      const sent = await deliverToInbox(name, head, incarnation, inbox);
      if (sent) return sent;
    }

    const before = capturePane(agent.tmuxSession, { colors: true });
    if (sessionIncarnation(readAgent(name) ?? agent) !== incarnation) return { status: "queued", reason: "unverified" };
    if (!before || parsedInputBoxText(before, provider) === null) return { status: "queued", reason: "unavailable" };
    let mark = pending?.id === head.id ? pending.mark : undefined;
    if (!inputBoxText(before, provider) && pending?.id === head.id && pending.message === head.message && pending.typed) {
      queuePopId(name, head.id);
      markDelivered(name, head.id, mark);
      rmSync(markerPath, { force: true });
      return { status: "submitted", id: head.id };
    }
    if (inputBoxText(before, provider)) {
      if (pending?.id !== head.id || pending.message !== head.message || !looksUnsubmitted(before, head.message, provider)) {
        return { status: "queued", reason: "composing" };
      }
      sendEnter(agent.tmuxSession);
    } else {
      // Persist before typing so a process crash with the text in the input box
      // is recoverable. A crash after submission can still cause redelivery;
      // the receiving TUI has no transactional acknowledgement protocol.
      mark = deliveryMark(name, head.id) ?? undefined;
      writeJsonAtomic(markerPath, { id: head.id, message: head.message, incarnation, mark });
      noteTypedAfterEscape(name, head.message);
      sendText(agent.tmuxSession, head.message, { enterDelayMs: enterDelayMs(agent, head.message) });
      writeJsonAtomic(markerPath, { id: head.id, message: head.message, incarnation, typed: true, mark });
    }

    for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
      await Bun.sleep(SUBMIT_CHECK_MS * 2 ** attempt);
      const pane = capturePane(agent.tmuxSession, { colors: true });
      const current = readAgent(name);
      if (!current || sessionIncarnation(current) !== incarnation) return { status: "queued", reason: "unverified" };
      if (!pane || parsedInputBoxText(pane, provider) === null) return { status: "queued", reason: "unverified" };
      if (parsedInputBoxText(pane, provider) === "") {
        queuePopId(name, head.id);
        markDelivered(name, head.id, mark);
        rmSync(markerPath, { force: true });
        return { status: "submitted", id: head.id };
      }
      if (!looksUnsubmitted(pane, head.message, provider)) return { status: "queued", reason: "unverified" };
      if (attempt < SUBMIT_RETRIES) sendEnter(agent.tmuxSession);
    }
    return { status: "queued", reason: "unverified" };
  } finally {
    releaseDeliverLock(name);
  }
}

// Codex's queue is durable, so a successful add is delivery. Claude's socket
// never replies, so its sends wait for the hook's confirmation. Claude frames
// inbox content as "not typed by your user", so operator messages carry an
// explicit marker there.
interface InboxSender {
  send: () => Promise<void>;
  confirm: boolean;
  content?: string;
  operatorTag?: string;
}

// Each Esc starts over: what was typed since an earlier one, or let it go,
// no longer counts.
function noteEscape(name: string, abortedKeys: (string | undefined)[]): void {
  updateAgentIf(name, (current) => {
    current.escapedAt = new Date().toISOString();
    current.escapedKeys = [...new Set(abortedKeys.filter((k): k is string => !!k))];
    delete current.typedSinceEscAt;
    delete current.typedSinceEscKeys;
    delete current.escReleasedAt;
    return true;
  });
}

// Esc the agent's turn, noted for codexQueueHeld. Callers hold the delivery lock.
export function escapeTurn(agent: AgentState): void {
  sendEscape(agent.tmuxSession);
  noteEscape(agent.name, [agent.promptKey, ...lateHookKeys(agent.name, agent)]);
}

const TYPED_SINCE_ESC_KEPT = 20;

// Before am types into a pane whose last Esc still holds, so the prompt that
// typing submits is recognisably one am typed after it.
export function noteTypedAfterEscape(name: string, message: string): void {
  updateAgentIf(name, (current) => {
    if (!current.escapedAt || current.escReleasedAt) return false;
    current.typedSinceEscAt ??= new Date().toISOString();
    current.typedSinceEscKeys = [...(current.typedSinceEscKeys ?? []), promptKey(message)].slice(-TYPED_SINCE_ESC_KEPT);
    return true;
  });
}

// promptAt is when the UserPromptSubmit hook ran, not when the prompt was
// submitted, so the hook for the prompt an Esc aborted can run after the Esc.
// Time can't tell them apart, so identity does: a prompt is the agent taking
// input again when its key isn't one the Esc may have aborted, or is one am
// typed since. The hold on Codex's queue lifts only once am has typed since
// the Esc, so a late hook whose key am never knew can't lift it either.
function abortedPrompt(agent: AgentState): boolean {
  return (agent.escapedKeys ?? []).includes(agent.promptKey ?? "")
    && !(agent.typedSinceEscKeys ?? []).includes(agent.promptKey ?? "");
}

// At UserPromptSubmit, once promptAt and promptKey are written. Decided on
// the current state, so a hook that read it before a later Esc can't lift
// that Esc's hold.
export function releaseEscapeHold(name: string): void {
  updateAgentIf(name, (agent) => {
    if (!agent.escapedAt || agent.escReleasedAt || !agent.promptAt || !agent.typedSinceEscAt) return false;
    if (!(Date.parse(agent.promptAt) > Date.parse(agent.typedSinceEscAt)) || abortedPrompt(agent)) return false;
    agent.escReleasedAt = agent.promptAt;
    return true;
  });
}

// Whether a prompt since the Esc at `escAt` started a turn of its own.
function promptSinceEsc(agent: AgentState, escAt: number): boolean {
  if (!(Date.parse(agent.promptAt ?? "") > escAt)) return false;
  return Date.parse(agent.escReleasedAt ?? "") > escAt || !abortedPrompt(agent);
}

// After an Esc, Codex leaves new queue entries unstarted until a prompt is
// submitted, so a message added then would sit there with the agent idle.
function codexQueueHeld(agent: AgentState): boolean {
  return agent.escapedAt !== undefined && agent.escReleasedAt === undefined;
}

// Entries handed to Codex's queue, oldest first, so an Esc that leaves them
// unstarted can take them back (reclaimCodexHandoffs). The body is kept
// because nothing else has it once the entry leaves am's queue: a record
// keeps only a hash. `key`: its prompt key, so the prompt hook can tell it
// started, tracked or not. `reclaiming`: its delete may have gone out.
// `uncertain`: the add's outcome is unknown, so am typed it as well.
// `retries`/`retryAt`: a reclaim that failed, to try again then.
interface CodexHandoff {
  entryId: string;
  message: string;
  key?: string;
  reclaiming?: boolean;
  uncertain?: boolean;
  retries?: number;
  retryAt?: number;
}

const CODEX_HANDOFFS_KEPT = 50;
// A failed reclaim is retried at once, then after 15s, 30s, ... up to 10
// minutes apart, and given up after the last.
const RECLAIM_RETRIES = 8;
const RECLAIM_BACKOFF_MS = 15_000;
const RECLAIM_BACKOFF_MAX_MS = 10 * 60_000;

function codexHandoffsPath(name: string): string {
  return join(queueDir(), name, ".codex-handoffs");
}

function codexHandoffsLock(name: string): string {
  return join(baseDir(), "locks", `codex-handoffs.${name}.lock`);
}

function readCodexHandoffs(name: string): CodexHandoff[] {
  return readJsonOrNull<CodexHandoff[]>(codexHandoffsPath(name)) ?? [];
}

// Locked, since the prompt hook prunes it without the delivery lock.
function updateCodexHandoffs(name: string, fn: (handoffs: CodexHandoff[]) => CodexHandoff[]): void {
  withFileLock(codexHandoffsLock(name), () => {
    const handoffs = fn(readCodexHandoffs(name)).slice(-CODEX_HANDOFFS_KEPT);
    if (handoffs.length) writeJsonAtomic(codexHandoffsPath(name), handoffs, { pretty: false });
    else rmSync(codexHandoffsPath(name), { force: true });
  });
}

// UserPromptSubmit saw this prompt: the entry it came from started, so it is
// no longer Codex's to hold or am's to take back. A tracked message's claim
// names its entry; otherwise the oldest entry with the prompt's key, as Codex
// starts its queue in order. An `uncertain` entry stays: am typed it too, and
// the prompt may be that copy, so only a reclaim settles Codex's.
export function dropCodexHandoff(name: string, key: string, startedId: string | null): void {
  if (!existsSync(codexHandoffsPath(name))) return;
  updateCodexHandoffs(name, (handoffs) => {
    const i = startedId
      ? handoffs.findIndex((h) => h.entryId === `${startedId}.json`)
      : handoffs.findIndex((h) => h.key === key && !h.uncertain);
    return i < 0 || handoffs[i]!.uncertain ? handoffs : handoffs.filter((_, j) => j !== i);
  });
}

// Noted before the add, so a crash after it still leaves the entry findable;
// one Codex never got is dropped when reclaimed. An add that may have landed
// keeps its note, marked, so a reclaim deletes the copy without restoring it.
async function handToCodexQueue(name: string, threadId: string, head: { id: string; message: string }): Promise<void> {
  const others = (handoffs: CodexHandoff[]) => handoffs.filter((h) => h.entryId !== head.id);
  const note = { entryId: head.id, message: head.message, key: promptKey(head.message) };
  updateCodexHandoffs(name, (handoffs) => [...others(handoffs), note]);
  try {
    await queueCodexMessage(threadId, head.message, clientMessageId(head.id));
  } catch (error) {
    updateCodexHandoffs(name, (handoffs) => error instanceof CodexOutcomeUnknown
      ? handoffs.map((h) => (h.entryId === head.id ? { ...h, uncertain: true } : h))
      : others(handoffs));
    throw error;
  }
}

// A reclaim cut short (a crash with a delete in flight, or a failure) left
// this entry to finish, and its next try is due.
function reclaimDue(h: CodexHandoff, now: number): boolean {
  return (h.reclaiming === true || h.retries !== undefined) && (h.retries ?? 0) < RECLAIM_RETRIES && (h.retryAt ?? 0) <= now;
}

// Whether deliverNext has a reclaim to finish for this agent though am's
// queue may be empty, so the drains that wait on queued messages run it too.
export function needsCodexRecovery(name: string): boolean {
  if (!existsSync(codexHandoffsPath(name))) return false;
  const now = Date.now();
  return readCodexHandoffs(name).some((h) => reclaimDue(h, now));
}

// After an Esc, Codex starts nothing more from its queue until a prompt is
// typed, so what still waits there would wait for good, already marked
// delivered. Take it back from Codex, then put it at the front of am's queue
// under its old id, its receipt queued again, for deliverNext to type.
// One entry at a time: it is marked before its delete goes out, and put back
// and unnoted as soon as Codex confirms the delete, before the next. A failure
// or crash part way leaves the rest in Codex's queue, the one in flight
// marked, and each a retry, backed off; `pendingOnly` finishes those. One
// gone from Codex's queue started, unless its delete may have gone out and
// the prompt hook never dropped its note (nor its record shows it started):
// then it was deleted, so it goes back. At worst a message is left where it
// was, or (a crash between putting it back and unnoting it, then a delivery
// that skips the recovery, or a prompt hook later than the recovery) delivered
// twice; in neither queue only if its delete went out unanswered and every
// retry then failed (logged on giving up). Callers hold the delivery lock.
async function reclaimCodexHandoffs(name: string, agent: AgentState, pendingOnly = false): Promise<void> {
  const threadId = agentSessionId(agent);
  const now = Date.now();
  const targets = readCodexHandoffs(name).filter((h) => !pendingOnly || reclaimDue(h, now));
  if (!threadId || !targets.length) return;
  const byClientId = new Map(targets.map((h) => [clientMessageId(h.entryId), h]));
  const mark = (h: CodexHandoff, fn: (x: CodexHandoff) => CodexHandoff) =>
    updateCodexHandoffs(name, (handoffs) => handoffs.map((x) => (x.entryId === h.entryId ? fn(x) : x)));
  const drop = (h: CodexHandoff) => updateCodexHandoffs(name, (handoffs) => handoffs.filter((x) => x.entryId !== h.entryId));
  // Under the notes' lock, so a prompt hook that drops the note first wins.
  const restore = (h: CodexHandoff, ifNoted: boolean) => {
    updateCodexHandoffs(name, (handoffs) => {
      if (ifNoted && !handoffs.some((x) => x.entryId === h.entryId)) return handoffs;
      // The hook claims a prompt before dropping its note: started means Codex ran it.
      if (ifNoted && !entryUnstarted(name, h.entryId)) return handoffs.filter((x) => x.entryId !== h.entryId);
      if (!h.uncertain) {
        queueRestoreLocked(name, h.entryId, h.message);
        try {
          requeueDelivered(name, h.entryId);
        } catch {
          // a receipt must not keep the message from being delivered
        }
      }
      return handoffs.filter((x) => x.entryId !== h.entryId);
    });
  };
  try {
    await reclaimCodexMessages(threadId, [...byClientId.keys()], {
      gone: (clientIds) => {
        for (const id of clientIds) {
          const h = byClientId.get(id)!;
          if (h.reclaiming && entryUnstarted(name, h.entryId)) restore(h, true);
          else drop(h);
        }
      },
      claiming: (clientId) => mark(byClientId.get(clientId)!, (x) => ({ ...x, reclaiming: true })),
      claimed: (clientId, deleted) => {
        const h = byClientId.get(clientId)!;
        if (deleted) restore(h, false);
        else drop(h);
      },
      unclaimed: (clientId) => mark(byClientId.get(clientId)!, ({ reclaiming: _, ...x }) => x),
    });
    // Codex started one, so it drains the rest itself.
    for (const h of targets) mark(h, ({ retries: _, retryAt: __, ...x }) => x);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const h of targets) {
      let retries = 0;
      updateCodexHandoffs(name, (handoffs) => handoffs.map((x) => {
        if (x.entryId !== h.entryId) return x;
        retries = (x.retries ?? 0) + 1;
        const delay = retries < 2 ? 0 : Math.min(RECLAIM_BACKOFF_MS * 2 ** (retries - 2), RECLAIM_BACKOFF_MAX_MS);
        return { ...x, retries, retryAt: Date.now() + delay };
      }));
      if (!retries) continue;
      console.error(retries < RECLAIM_RETRIES
        ? `am: could not take back "${name}"'s message ${h.entryId} from the Codex queue (try ${retries} of ${RECLAIM_RETRIES}): ${reason}`
        : `am: giving up taking back "${name}"'s message ${h.entryId} from the Codex queue after ${retries} tries: ${reason}`);
    }
  }
}

function inboxSender(agent: AgentState, head: { id: string; message: string }): InboxSender | null {
  if (agentProvider(agent) === "codex") {
    const threadId = agentSessionId(agent);
    return threadId && !codexQueueHeld(agent)
      ? { send: () => handToCodexQueue(agent.name, threadId, head), confirm: false }
      : null;
  }
  const operatorTag = isAttributedBody(head.message) ? undefined : randomBytes(8).toString("hex");
  const content = operatorTag ? operatorEnvelope(head.message, operatorTag) : head.message;
  if (!peerSendable(content)) return null;
  const target = peerTarget(agent);
  return target ? { send: () => sendPeerMessage(target, content, randomUUID()), confirm: true, content, operatorTag } : null;
}

// Null means the inbox was unusable, so the caller types the message instead.
async function deliverToInbox(
  name: string,
  head: { id: string; message: string },
  incarnation: string,
  inbox: InboxSender,
): Promise<DeliveryResult | null> {
  const markerPath = pendingPath(name);
  const mark = deliveryMark(name, head.id) ?? undefined;
  if (!inbox.confirm) {
    try {
      await inbox.send();
    } catch {
      return null;
    }
    queuePopId(name, head.id);
    markDelivered(name, head.id, mark);
    return { status: "submitted", id: head.id };
  }
  rmSync(confirmedPath(name), { force: true });
  writeJsonAtomic(markerPath, {
    id: head.id,
    message: head.message,
    incarnation,
    via: "inbox",
    sentAt: Date.now(),
    content: inbox.content,
    operatorTag: inbox.operatorTag,
    mark,
  });
  try {
    await inbox.send();
  } catch {
    rmSync(markerPath, { force: true });
    return null;
  }
  for (const deadline = Date.now() + INBOX_CONFIRM_MS; Date.now() < deadline;) {
    await Bun.sleep(200);
    if (deliveryConfirmed(name, head.id)) {
      finishDelivery(name, head.id);
      return { status: "submitted", id: head.id };
    }
  }
  return { status: "queued", reason: "unverified" };
}

export type CancelResult = { ok: true; state: "cancelled" } | Conflict;

const CANCEL_WAIT_MS = 10_000;

// Cancel a tracked message that is still queued. It takes the delivery lock
// (so no deliverer or hook can pop it mid-cancel) and the producer lock (so
// its enqueue is complete), waiting out a delivery in progress. Null: no such
// message.
export async function cancelMessage(name: string, id: string): Promise<CancelResult | null> {
  if (!isMessageId(id)) return null;
  for (const deadline = Date.now() + CANCEL_WAIT_MS; ;) {
    const record = readMessage(name, id);
    if (!record) return null;
    if (record.state !== "queued") {
      return { ok: false, error: `message ${id} is already ${record.state}`, state: record.state, reason: alreadyReason(record.state) };
    }
    if (acquireDeliverLock(name)) {
      try {
        if (acquireProducerLock(name)) {
          try {
            return cancelQueuedLocked(name, id, pendingDeliveryId(name) === `${id}.json`);
          } finally {
            releaseProducerLock(name);
          }
        }
      } finally {
        releaseDeliverLock(name);
      }
    }
    if (Date.now() >= deadline) return { ok: false, error: `agent "${name}" mailbox is busy — retry the cancel`, state: "queued", reason: "mailbox_busy" };
    await Bun.sleep(100);
  }
}

export type InterruptResult = { ok: true; state: "delivered" } | Conflict;

function notInterruptible(id: string, state: MessageState): InterruptResult {
  if (state === "queued") return { ok: false, error: `message ${id} is not delivered yet`, state, reason: "not_delivered" };
  return { ok: false, error: `message ${id} is already ${state}`, state, reason: alreadyReason(state) };
}

const ABORT_POLL_MS = 250;
const ABORT_POLLS = 16;
// Wall-clock cap on waiting out an Esc, clearing included.
const ABORT_WAIT_MS = 5000;
const CLEAR_PRESSES = 20;
// A TUI can take a while to redraw after a press, so each press waits up to
// CLEAR_REDRAW_POLLS × CLEAR_POLL_MS for the composer to shorten, and only
// CLEAR_STALLS presses in a row that never do mean it won't.
const CLEAR_POLL_MS = 100;
const CLEAR_REDRAW_POLLS = 5;
const CLEAR_STALLS = 2;

// One row per press, while the composer holds what is left of `text`. False
// when presses leave it no shorter: something else holds the composer.
async function clearComposer(agent: AgentState, text: string, deadline: number): Promise<boolean> {
  let length = text.length;
  let stalls = 0;
  for (let press = 0; press < CLEAR_PRESSES && Date.now() < deadline; press++) {
    sendClearLine(agent.tmuxSession);
    let shortened = false;
    for (let poll = 0; poll < CLEAR_REDRAW_POLLS && !shortened && Date.now() < deadline; poll++) {
      await Bun.sleep(CLEAR_POLL_MS);
      const pane = capturePane(agent.tmuxSession, { colors: true });
      const left = pane && parsedInputBoxText(pane, agentProvider(agent));
      if (!left || !text.startsWith(left)) return true;
      if (left.length < length) {
        length = left.length;
        shortened = true;
      }
    }
    stalls = shortened ? 0 : stalls + 1;
    if (stalls >= CLEAR_STALLS) return false;
  }
  return false;
}

// Neither TUI fires Stop for a turn aborted with Esc, so nothing else ends it:
// the agent stays working, its receipts delivered, its queue undrained. Once
// the pane is back at an empty composer (the check deliverNext submits by)
// with no running-turn hint (which an Esc the turn ignored leaves up),
// end the turn as a Stop would, its receipts done and marked interrupted, and
// deliver what is queued. A Stop or a prompt since the Esc means the turn
// ended or a new one started, either of which brings its own Stop; a late
// hook for the prompt the Esc aborted is neither (promptSinceEsc).
export async function endAbortedTurn(name: string, escAt: number): Promise<boolean> {
  const deadline = escAt + ABORT_WAIT_MS;
  let clearFailed = false;
  for (let poll = 0; poll < ABORT_POLLS && Date.now() < deadline; poll++) {
    await Bun.sleep(ABORT_POLL_MS);
    const agent = readAgent(name);
    if (!agent || !hasSession(agent.tmuxSession)) return false;
    if (agent.status !== "working" && agent.status !== "needs-attention") return false;
    if (promptSinceEsc(agent, escAt)) return false;
    const pane = capturePane(agent.tmuxSession, { colors: true });
    const input = pane && parsedInputBoxText(pane, agentProvider(agent));
    if (!pane || input === null || turnRunning(pane, agentProvider(agent))) continue;
    if (input !== "") {
      // Claude puts back a prompt Esc'd before its turn got going. Left
      // there, it would hold the queue behind it, and Enter would rerun it.
      if (!clearFailed && promptKey(input) === agent.promptKey) clearFailed = !(await clearComposer(agent, input, deadline));
      continue;
    }
    // A Codex agent's queue is reclaimed before any deliverer sees it idle,
    // so a reclaimed message keeps its place ahead of what was queued after.
    const codex = agentProvider(agent) === "codex";
    if (codex && !acquireDeliverLock(name)) continue;
    try {
      // Recheck under the state lock: a prompt or Stop since the capture wins.
      const ended = updateAgentIf(name, (current) => {
        if (current.status !== "working" && current.status !== "needs-attention") return false;
        if (promptSinceEsc(current, escAt)) return false;
        updateAgentStatus(current, "idle");
        delete current.workingSince;
        return true;
      });
      if (!ended) return false;
      try {
        // Bounded by the Esc, so a turn started since keeps its receipts.
        markTurnEnded(name, agent, new Date(escAt), true);
      } catch {
        // a receipt must not keep the agent working
      }
      if (codex) await reclaimCodexHandoffs(name, agent);
    } finally {
      if (codex) releaseDeliverLock(name);
    }
    if (queueDepth(name) > 0 || (codex && needsCodexRecovery(name))) await deliverNext(name);
    return true;
  }
  console.error(`am: "${name}" did not return to its prompt after Esc; leaving it as it is`);
  return false;
}

// Esc the turn handling a delivered message, once, and only that turn. The delivery
// lock keeps the next message from being handed over, and the records lock
// keeps the Stop hook from marking it done, between the check and the Esc.
// Null: no such message.
export async function interruptMessage(name: string, id: string): Promise<InterruptResult | null> {
  if (!isMessageId(id)) return null;
  for (const deadline = Date.now() + CANCEL_WAIT_MS; ;) {
    const record = readMessage(name, id);
    if (!record) return null;
    if (record.state !== "delivered") return notInterruptible(id, record.state);
    if (acquireDeliverLock(name)) {
      let result: InterruptResult | null;
      let abortedKey: string | undefined;
      const escAt = Date.now();
      try {
        result = withSettledRecord(name, id, (current, save): InterruptResult => {
          if (current.state !== "delivered") return notInterruptible(id, current.state);
          // A delivered message can still wait behind an earlier turn (Codex's
          // queue, a deferred steer); Esc then would abort that turn instead.
          if (!current.startedAt && current.via !== "absorbed") {
            return { ok: false, error: `message ${id} has not started yet`, state: "delivered", reason: "not_started" };
          }
          // A second Esc rewinds the conversation in both TUIs.
          if (current.interruptedAt) {
            return { ok: false, error: `message ${id} was already interrupted`, state: "delivered", reason: "already_interrupted" };
          }
          const agent = readAgent(name);
          if (!agent || !hasSession(agent.tmuxSession)) {
            return { ok: false, error: `agent "${name}" has no live tmux session`, state: current.state, reason: "no_session" };
          }
          sendEscape(agent.tmuxSession);
          abortedKey = current.promptKey;
          save({ ...current, interruptedAt: new Date().toISOString() });
          return { ok: true, state: "delivered" };
        });
        // Outside the records lock, but before a delivery can follow.
        if (result?.ok) noteEscape(name, [abortedKey]);
      } finally {
        releaseDeliverLock(name);
      }
      if (result?.ok) await endAbortedTurn(name, escAt);
      return result;
    }
    if (Date.now() >= deadline) return { ok: false, error: `agent "${name}" mailbox is busy — retry`, state: record.state, reason: "mailbox_busy" };
    await Bun.sleep(100);
  }
}

// `am queue --clear`: under both locks, so no enqueue or delivery interleaves
// with marking the receipts and removing the entries.
export async function clearQueue(name: string): Promise<void> {
  for (const deadline = Date.now() + CANCEL_WAIT_MS; ;) {
    if (acquireDeliverLock(name)) {
      try {
        if (acquireProducerLock(name)) {
          try {
            clearQueuedLocked(name, pendingDeliveryId(name));
            queueClearEntries(name);
            return;
          } finally {
            releaseProducerLock(name);
          }
        }
      } finally {
        releaseDeliverLock(name);
      }
    }
    if (Date.now() >= deadline) throw new Error(`agent "${name}" mailbox is busy — retry`);
    await Bun.sleep(100);
  }
}

// Fire-and-forget delivery from inside a hook. The hook must exit promptly
// (Claude Code blocks on it), and the TUI needs a beat to get back to its
// prompt — so a detached process sleeps briefly, then delivers.
export function spawnDeliver(name: string): void {
  // Output goes to the daemon's log: this fallback runs precisely when the
  // daemon (and so its own logging) is down — a delivery failure here used to
  // vanish into "ignore".
  let out: number | "ignore" = "ignore";
  try {
    out = openLogFd(daemonLogFile(), DAEMON_LOG_MAX_BYTES);
  } catch {
    // no log — deliver silent rather than not at all
  }
  try {
    Bun.spawn({
      cmd: [process.execPath, cliEntrypoint(), "__deliver", name],
      env: { ...process.env },
      stdin: "ignore",
      stdout: out,
      stderr: out,
    }).unref();
  } finally {
    if (typeof out === "number") closeSync(out);
  }
}

export async function deliverCommand(name: string): Promise<void> {
  await Bun.sleep(500);
  await deliverNext(name);
}
