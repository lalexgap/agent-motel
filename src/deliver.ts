import { closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, readAgent, type AgentState, type Provider } from "./state";
import { queueHead, queuePopId } from "./queue";
import { capturePane, hasSession, sendEnter, sendText, stripSgr, tmux } from "./tmux";
import { cliEntrypoint } from "./settings";
import { DAEMON_LOG_MAX_BYTES, daemonLogFile, queueDir } from "./paths";
import { openLogFd, readJsonOrNull, writeJsonAtomic } from "./fsutil";
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
  if (agentProvider(agent) === "codex") return 150;
  if (message?.includes("\n")) return 200;
  return undefined;
}

// Claude displays a dim `Try "..."` placeholder inside its bordered composer.
const PLACEHOLDER_RE = /^Try "/;

export function parsedInputBoxText(pane: string[], provider: Provider = "claude"): string | null {
  const plain = pane.map(stripSgr);
  if (provider === "codex") {
    // Codex has an unbordered composer above its model/status footer. Require
    // both the footer and the prompt so transcript text is never an empty box.
    let shortcut = -1;
    for (let i = 0; i < plain.length; i++) if (/^\s*\? for shortcuts\b/.test(plain[i]!)) shortcut = i;
    if (shortcut < 0) return null;
    let footer = shortcut - 1;
    while (footer >= 0 && !plain[footer]!.trim()) footer--;
    if (footer < 0 || !/^\s+\S.*[·•]/.test(plain[footer]!)) return null;
    let prompt = -1;
    for (let i = 0; i < footer; i++) if (/^\s*›(?:\s|$)/.test(plain[i]!)) prompt = i;
    if (prompt < 0) return null;
    const text = plain.slice(prompt, footer).join(" ").replace(/^\s*›\s*/, "").replace(/\s+/g, " ").trim();
    return text === "Ask Codex to do anything" ? "" : text;
  }
  const seps: number[] = [];
  for (let i = 0; i < plain.length; i++) if (/─{8,}/.test(plain[i]!)) seps.push(i);
  if (seps.length < 2) return null;
  const text = plain
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

// If the head of our message is still sitting in the input box after the
// Enter, the submit got eaten.
export function looksUnsubmitted(pane: string[], message: string, provider: Provider = "claude"): boolean {
  const head = message.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 24);
  if (!head) return false;
  return inputBoxText(pane, provider).includes(head);
}

const SUBMIT_RETRIES = 2;
const SUBMIT_CHECK_MS = 600;

export type DeliveryResult =
  | { status: "submitted"; id: string }
  | { status: "queued"; reason: "unavailable" | "locked" | "empty" | "composing" | "unverified" };

// The marker records which queued message we typed. If Enter is swallowed,
// later attempts press Enter again instead of appending the text a second time.
interface PendingDelivery {
  id: string;
  message: string;
  typed?: boolean;
  incarnation?: string;
}

function sessionIncarnation(agent: AgentState): string | null {
  const result = tmux("display-message", "-p", "-t", `=${agent.tmuxSession}`, "#{pid}:#{session_id}:#{session_created}:#{pane_id}:#{pane_pid}");
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  return JSON.stringify([agentProvider(agent), result.stdout.trim()]);
}

export function pendingDeliveryId(name: string): string | null {
  const pending = readJsonOrNull<PendingDelivery>(join(queueDir(), name, ".delivery.pending"));
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
    const pendingPath = join(queueDir(), name, ".delivery.pending");
    const marker = readJsonOrNull<PendingDelivery>(pendingPath);
    const pending = marker?.incarnation === incarnation ? marker : null;
    const provider = agentProvider(agent);
    const before = capturePane(agent.tmuxSession);
    if (sessionIncarnation(readAgent(name) ?? agent) !== incarnation) return { status: "queued", reason: "unverified" };
    if (!before || parsedInputBoxText(before, provider) === null) return { status: "queued", reason: "unavailable" };
    if (!inputBoxText(before, provider) && pending?.id === head.id && pending.message === head.message && pending.typed) {
      queuePopId(name, head.id);
      rmSync(pendingPath, { force: true });
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
      writeJsonAtomic(pendingPath, { id: head.id, message: head.message, incarnation });
      sendText(agent.tmuxSession, head.message, { enterDelayMs: enterDelayMs(agent, head.message) });
      writeJsonAtomic(pendingPath, { id: head.id, message: head.message, incarnation, typed: true });
    }

    for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
      await Bun.sleep(SUBMIT_CHECK_MS);
      const pane = capturePane(agent.tmuxSession);
      const current = readAgent(name);
      if (!current || sessionIncarnation(current) !== incarnation) return { status: "queued", reason: "unverified" };
      if (!pane || parsedInputBoxText(pane, provider) === null) return { status: "queued", reason: "unverified" };
      if (!looksUnsubmitted(pane, head.message, provider)) {
        queuePopId(name, head.id);
        rmSync(pendingPath, { force: true });
        return { status: "submitted", id: head.id };
      }
      if (attempt < SUBMIT_RETRIES) sendEnter(agent.tmuxSession);
    }
    return { status: "queued", reason: "unverified" };
  } finally {
    releaseDeliverLock(name);
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
