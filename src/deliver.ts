import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, agentSessionId, readAgent, type AgentState, type Provider } from "./state";
import { queueHead, queuePopId } from "./queue";
import { capturePane, hasSession, sendEnter, sendText, stripFaint, stripSgr, tmux } from "./tmux";
import { cliEntrypoint } from "./settings";
import { DAEMON_LOG_MAX_BYTES, daemonLogFile, queueDir } from "./paths";
import { openLogFd, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { isAttributedBody, operatorEnvelope } from "./comms";
import { peerSendable, peerTarget, sendPeerMessage } from "./claudePeer";
import { clientMessageId, queueCodexMessage } from "./codexQueue";
import { acquireMailboxLock, beginHandoff, endHandoff, mailboxLockPath, releaseMailboxLock, renewHandoff } from "./mailbox";

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
// deliverer holds the lock while it waits for exactly this. Returns the
// operator tag when the confirmed message is the operator's, so the hook can
// vouch for it.
export function confirmInboxDelivery(name: string, prompt: string): string | null {
  const pending = readJsonOrNull<PendingDelivery>(pendingPath(name));
  // Markers written before `content` existed came only from peer sends, whose content was the message itself.
  const content = pending?.content ?? (pending && isAttributedBody(pending.message) ? pending.message : null);
  if (pending?.via !== "inbox" || !content || !normalized(prompt).includes(normalized(content))) return null;
  writeJsonAtomic(confirmedPath(name), { id: pending.id });
  return pending.operatorTag ?? null;
}

function deliveryConfirmed(name: string, id: string): boolean {
  return readJsonOrNull<{ id?: string }>(confirmedPath(name))?.id === id;
}

function finishDelivery(name: string, id: string): void {
  queuePopId(name, id);
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
    if (!inputBoxText(before, provider) && pending?.id === head.id && pending.message === head.message && pending.typed) {
      queuePopId(name, head.id);
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
      writeJsonAtomic(markerPath, { id: head.id, message: head.message, incarnation });
      sendText(agent.tmuxSession, head.message, { enterDelayMs: enterDelayMs(agent, head.message) });
      writeJsonAtomic(markerPath, { id: head.id, message: head.message, incarnation, typed: true });
    }

    for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
      await Bun.sleep(SUBMIT_CHECK_MS * 2 ** attempt);
      const pane = capturePane(agent.tmuxSession, { colors: true });
      const current = readAgent(name);
      if (!current || sessionIncarnation(current) !== incarnation) return { status: "queued", reason: "unverified" };
      if (!pane || parsedInputBoxText(pane, provider) === null) return { status: "queued", reason: "unverified" };
      if (parsedInputBoxText(pane, provider) === "") {
        queuePopId(name, head.id);
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

function inboxSender(agent: AgentState, head: { id: string; message: string }): InboxSender | null {
  if (agentProvider(agent) === "codex") {
    const threadId = agentSessionId(agent);
    return threadId
      ? { send: () => queueCodexMessage(threadId, head.message, clientMessageId(head.id)), confirm: false }
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
  if (!inbox.confirm) {
    try {
      await inbox.send();
    } catch {
      return null;
    }
    queuePopId(name, head.id);
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
