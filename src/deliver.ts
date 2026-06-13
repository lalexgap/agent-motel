import { agentProvider, readAgent, type AgentState } from "./state";
import { queuePeek, queuePop } from "./queue";
import { capturePane, hasSession, sendEnter, sendText } from "./tmux";
import { cliEntrypoint } from "./settings";

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
