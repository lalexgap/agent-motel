import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentProvider, readAgent, type AgentState } from "./state";
import { queuePeek, queuePop } from "./queue";
import { capturePane, hasSession, sendEnter, sendText } from "./tmux";
import { cliEntrypoint } from "./settings";
import { queueDir } from "./paths";
import { channelActive } from "./channel";

// Per-agent delivery lock. deliverNext can be invoked concurrently from three
// places — the Stop hook's detached process, the daemon's /event handler, and
// the reconcile loop — so an in-process flag isn't enough; without this two
// callers can peek the same queue head and type it into the pane twice.
//
// We write a unique token and read it back to confirm ownership. The exclusive
// create (flag "wx") is the fast path; a STALE lock (holder crashed) is stolen
// by overwriting then verifying the read-back is still our token. The read-back
// resolves the steal race — if two stealers race, last-writer-wins and only one
// sees its own token — so a fresh lock is never clobbered into a double-hold.
// [hardened per review M2: replaces the rm-then-recreate TOCTOU]
const LOCK_STALE_MS = 30_000;

function lockPath(name: string): string {
  return join(queueDir(), `${name}.deliver.lock`);
}

export function acquireDeliverLock(name: string): boolean {
  const path = lockPath(name);
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(path, token, { flag: "wx" }); // exclusive create
  } catch {
    // exists — only steal if stale
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return false; // vanished under us — let another caller take it next time
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false;
    writeFileSync(path, token); // overwrite the stale lock (last writer wins)
  }
  // Confirm we actually own it — a racing stealer may have overwritten us.
  try {
    return readFileSync(path, "utf8") === token;
  } catch {
    return false;
  }
}

export function releaseDeliverLock(name: string): void {
  rmSync(lockPath(name), { force: true });
}

// Exposed for tests.
export const __lockStaleMs = LOCK_STALE_MS;
export { lockPath as __lockPath };

export function enterDelayMs(agent: AgentState, message?: string): number | undefined {
  // Codex always drops an Enter that lands in the same key batch as the
  // text; Claude Code does the same intermittently for MULTI-LINE sends
  // (bracketed-paste detection) — the migration briefs are exactly that.
  if (agentProvider(agent) === "codex") return 150;
  if (message?.includes("\n")) return 200;
  return undefined;
}

// Claude/codex render the input box between the last two horizontal
// separators. Fresh sessions show a dim `Try "..."` placeholder, which is
// not human text.
const PLACEHOLDER_RE = /^Try "/;

export function inputBoxText(pane: string[]): string {
  const plain = pane.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  const seps: number[] = [];
  for (let i = 0; i < plain.length; i++) if (/─{8,}/.test(plain[i]!)) seps.push(i);
  if (seps.length < 2) return "";
  const text = plain
    .slice(seps[seps.length - 2]! + 1, seps[seps.length - 1]!)
    .join(" ")
    .replace(/❯/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return PLACEHOLDER_RE.test(text) ? "" : text;
}

// If the head of our message is still sitting in the input box after the
// Enter, the submit got eaten.
export function looksUnsubmitted(pane: string[], message: string): boolean {
  const head = message.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 24);
  if (head.length < 4) return false;
  return inputBoxText(pane).includes(head);
}

const SUBMIT_RETRIES = 2;
const SUBMIT_CHECK_MS = 600;

// Type the queue head into the agent's session. Peek → send → pop, so a
// failed send leaves the message queued for the next attempt instead of
// dropping it. After sending, verify the prompt actually left the input box
// and re-press Enter if the submit was swallowed (it sometimes is, right
// after SessionStart — Alex was hitting Enter by hand on migration briefs).
export async function deliverNext(name: string): Promise<boolean> {
  const agent = readAgent(name);
  if (!agent || !hasSession(agent.tmuxSession)) return false;
  if (channelActive(name)) return false; // a channel owns this agent's inbound — don't also type
  // Serialize delivery for this agent across processes — held through the verify
  // loop so a concurrent caller can't grab the same (or the next) queue head.
  if (!acquireDeliverLock(name)) return false;
  try {
    const message = queuePeek(name);
    if (message === null) return false;

    // Someone (usually the human) is mid-composition in the input box: typing
    // our message now would splice into theirs. Leave it queued — the daemon's
    // reconcile loop and the next Stop drain retry until the box clears.
    const before = capturePane(agent.tmuxSession);
    if (before && inputBoxText(before)) return false;

    sendText(agent.tmuxSession, message, { enterDelayMs: enterDelayMs(agent, message) });
    queuePop(name);

    for (let attempt = 0; attempt < SUBMIT_RETRIES; attempt++) {
      await Bun.sleep(SUBMIT_CHECK_MS);
      const pane = capturePane(agent.tmuxSession);
      if (!pane || !looksUnsubmitted(pane, message)) break;
      sendEnter(agent.tmuxSession);
    }
    return true;
  } finally {
    releaseDeliverLock(name);
  }
}

// Fire-and-forget delivery from inside a hook. The hook must exit promptly
// (Claude Code blocks on it), and the TUI needs a beat to get back to its
// prompt — so a detached process sleeps briefly, then delivers.
export function spawnDeliver(name: string): void {
  Bun.spawn({
    cmd: [process.execPath, cliEntrypoint(), "__deliver", name],
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}

export async function deliverCommand(name: string): Promise<void> {
  await Bun.sleep(500);
  await deliverNext(name);
}
