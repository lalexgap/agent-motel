import { closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, readAgent, type AgentState, type Provider } from "./state";
import { queueHead, queuePopId } from "./queue";
import { capturePane, hasSession, sendEnter, sendText, stripSgr } from "./tmux";
import { cliEntrypoint } from "./settings";
import { DAEMON_LOG_MAX_BYTES, daemonLogFile, queueDir, baseDir } from "./paths";
import { openLogFd, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { tryAcquireFileLock } from "./filelock";

// Keep the lock inode in place: unlinking it would let another process lock a
// new inode while the current holder is still delivering. The kernel releases
// flock automatically if a holder crashes.
const deliveryLocks = new Map<string, () => void>();

function lockPath(name: string): string {
  return join(baseDir(), "locks", `delivery.${name}.lock`);
}

export function acquireDeliverLock(name: string): boolean {
  const path = lockPath(name);
  if (deliveryLocks.has(path)) return false;
  const release = tryAcquireFileLock(path);
  if (!release) return false;
  deliveryLocks.set(path, release);
  return true;
}

export function releaseDeliverLock(name: string): void {
  const path = lockPath(name);
  const release = deliveryLocks.get(path);
  if (!release) return;
  deliveryLocks.delete(path);
  release();
}

export { lockPath as __lockPath };

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
}

export function pendingDeliveryId(name: string): string | null {
  return readJsonOrNull<PendingDelivery>(join(queueDir(), name, ".delivery.pending"))?.id ?? null;
}

export async function deliverNext(name: string): Promise<DeliveryResult> {
  const agent = readAgent(name);
  if (!agent || !hasSession(agent.tmuxSession)) return { status: "queued", reason: "unavailable" };
  if (!acquireDeliverLock(name)) return { status: "queued", reason: "locked" };
  try {
    const head = queueHead(name);
    if (head === null) return { status: "queued", reason: "empty" };
    const pendingPath = join(queueDir(), name, ".delivery.pending");
    const pending = readJsonOrNull<PendingDelivery>(pendingPath);
    const provider = agentProvider(agent);
    const before = capturePane(agent.tmuxSession);
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
      writeJsonAtomic(pendingPath, { id: head.id, message: head.message });
      sendText(agent.tmuxSession, head.message, { enterDelayMs: enterDelayMs(agent, head.message) });
      writeJsonAtomic(pendingPath, { id: head.id, message: head.message, typed: true });
    }

    for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
      await Bun.sleep(SUBMIT_CHECK_MS);
      const pane = capturePane(agent.tmuxSession);
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
