import { randomUUID } from "node:crypto";
import { closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, agentSessionId, readAgent, updateAgentStatus, writeAgent, type AgentState, type Provider } from "./state";
import { queueClearEntries, queueDepth, queueHead, queuePopId } from "./queue";
import { capturePane, hasSession, sendEnter, sendEscape, sendText, stripFaint, stripSgr, tmux } from "./tmux";
import { cliEntrypoint } from "./settings";
import { DAEMON_LOG_MAX_BYTES, daemonLogFile, queueDir } from "./paths";
import { openLogFd, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { isAttributedBody } from "./comms";
import { peerSendable, peerTarget, sendPeerMessage } from "./claudePeer";
import { clientMessageId, queueCodexMessage } from "./codexQueue";
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
  isMessageId,
  markDelivered,
  markTurnEnded,
  readMessage,
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
// deliverer holds the lock while it waits for exactly this.
export function confirmInboxDelivery(name: string, prompt: string, promptAt?: string): void {
  const pending = readJsonOrNull<PendingDelivery>(pendingPath(name));
  if (pending?.via !== "inbox" || !normalized(prompt).includes(normalized(pending.message))) return;
  writeJsonAtomic(confirmedPath(name), { id: pending.id, promptAt });
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
    const head = queueHead(name);
    if (head === null) return { status: "queued", reason: "empty" };
    const markerPath = pendingPath(name);
    const marker = readJsonOrNull<PendingDelivery>(markerPath);
    let pending = marker?.incarnation === incarnation ? marker : null;
    const provider = agentProvider(agent);

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
// inbox content as "not typed by your user", which would demote an operator's
// message, so only peer messages go that way.
interface InboxSender {
  send: () => Promise<void>;
  confirm: boolean;
}

function inboxSender(agent: AgentState, head: { id: string; message: string }): InboxSender | null {
  if (agentProvider(agent) === "codex") {
    const threadId = agentSessionId(agent);
    return threadId
      ? { send: () => queueCodexMessage(threadId, head.message, clientMessageId(head.id)), confirm: false }
      : null;
  }
  if (!isAttributedBody(head.message) || !peerSendable(head.message)) return null;
  const target = peerTarget(agent);
  return target ? { send: () => sendPeerMessage(target, head.message, randomUUID()), confirm: true } : null;
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
  writeJsonAtomic(markerPath, { id: head.id, message: head.message, incarnation, via: "inbox", sentAt: Date.now(), mark });
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

// Neither TUI fires Stop for a turn aborted with Esc, so nothing else ends it:
// the agent stays working, its receipts delivered, its queue undrained. Once
// the pane is back at an empty composer (the check deliverNext submits by)
// with no running-turn hint (which an Esc the turn ignored leaves up),
// end the turn as a Stop would, its receipts done and marked interrupted, and
// deliver what is queued. A Stop or a prompt since the Esc means the turn
// ended or a new one started, either of which brings its own Stop.
export async function endAbortedTurn(name: string, escAt: number): Promise<boolean> {
  for (let poll = 0; poll < ABORT_POLLS; poll++) {
    await Bun.sleep(ABORT_POLL_MS);
    const agent = readAgent(name);
    if (!agent || !hasSession(agent.tmuxSession)) return false;
    if (agent.status !== "working" && agent.status !== "needs-attention") return false;
    if (Date.parse(agent.promptAt ?? "") > escAt) return false;
    const pane = capturePane(agent.tmuxSession, { colors: true });
    if (!pane || parsedInputBoxText(pane, agentProvider(agent)) !== "" || turnRunning(pane, agentProvider(agent))) continue;
    const at = new Date();
    try {
      markTurnEnded(name, agent, at, true);
    } catch {
      // a receipt must not keep the agent working
    }
    updateAgentStatus(agent, "idle", undefined, at.toISOString());
    agent.workingSince = undefined;
    writeAgent(agent);
    if (queueDepth(name) > 0) await deliverNext(name);
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
          save({ ...current, interruptedAt: new Date().toISOString() });
          return { ok: true, state: "delivered" };
        });
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
