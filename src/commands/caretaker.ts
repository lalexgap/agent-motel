import { homedir } from "node:os";
import { loadConfig } from "../config";
import {
  readAgent,
  recordAttached,
  agentSessionId,
  agentProvider,
} from "../state";
import { attachOrSwitch, hasSession } from "../tmux";
import { CARETAKER_ROLE } from "../roles";
import { queueDepth, queueAppendLocked } from "../queue";
import { tryAcquireFileLock } from "../filelock";
import { baseDir } from "../paths";
import { join } from "node:path";
import { newCommand, type NewOptions } from "./new";
import { reviveAgent } from "./resume";
import { sendCommand } from "./send";
import { runIfIdle } from "./rm";
import { deliverNext } from "../deliver";

export const CARETAKER_NAME = "caretaker";
export const CARETAKER_SCAN =
  "Perform a read-only housekeeping scan. Check unused worktrees and agents that may be ready to close. Give a short numbered list of candidates with evidence, uncertainty, and the exact proposed action. This scheduled scan authorizes inspection only, never stopping agents or deleting anything. Ask the operator to approve specific targets; if nothing needs attention, say so in one sentence.";

export function caretakerNewOptions(message = CARETAKER_SCAN): NewOptions {
  const config = loadConfig();
  return {
    name: CARETAKER_NAME,
    role: CARETAKER_ROLE,
    provider: "codex",
    model: config.caretakerModel,
    effort: config.caretakerEffort,
    dir: homedir(),
    inPlace: true,
    message,
    jump: false,
    quiet: true,
  };
}

export async function caretakerCommand(opts: {
  question?: string;
  scan?: boolean;
  jump?: boolean;
}): Promise<void> {
  if (opts.scan && opts.question)
    throw new Error("--scan cannot include an operator message");
  const release = tryAcquireFileLock(
    join(baseDir(), "locks", "caretaker.open.lock"),
  );
  if (!release)
    throw new Error("caretaker is already being opened — retry shortly");
  let skipped = false;
  try {
    const existing = readAgent(CARETAKER_NAME);
    if (
      existing &&
      (existing.role !== CARETAKER_ROLE || agentProvider(existing) !== "codex")
    ) {
      throw new Error(
        'an unrelated agent is named "caretaker"; rename it before opening the caretaker',
      );
    }
    const message = opts.scan ? CARETAKER_SCAN : opts.question;
    if (!existing) {
      await newCommand(caretakerNewOptions(message));
    } else if (!hasSession(existing.tmuxSession)) {
      if (opts.scan && queueDepth(CARETAKER_NAME) > 0) {
        skipped = true;
      } else {
        if (!agentSessionId(existing))
          throw new Error(
            "caretaker has no captured session ID; refusing to resume an unrelated conversation. Archive it with am rm caretaker, then reopen it.",
          );
        await reviveAgent(existing, { message: message ?? CARETAKER_SCAN });
      }
    } else if (opts.scan) {
      const admitted = await runIfIdle(existing, {}, (current) => {
        if (
          current.createdAt !== existing.createdAt ||
          current.role !== CARETAKER_ROLE ||
          agentProvider(current) !== "codex" ||
          !hasSession(current.tmuxSession)
        )
          return false;
        queueAppendLocked(CARETAKER_NAME, CARETAKER_SCAN);
        return true;
      });
      skipped = !admitted.ok || !admitted.value;
      if (!skipped) await deliverNext(CARETAKER_NAME);
    } else if (message) {
      const result = await sendCommand(CARETAKER_NAME, message, {
        now: false,
        quiet: true,
      });
      if (result.outcome === "dropped" || result.outcome === "outbox")
        throw new Error(`caretaker message was ${result.outcome}`);
    }
  } finally {
    release();
  }
  if (
    opts.scan ||
    opts.jump === false ||
    !process.stdout.isTTY ||
    !process.stdin.isTTY
  ) {
    console.log(
      skipped
        ? "caretaker busy — skipped scheduled scan"
        : "caretaker ready — am j caretaker to review its proposals",
    );
    return;
  }
  const agent = readAgent(CARETAKER_NAME);
  if (!agent) throw new Error("caretaker disappeared before attach — retry");
  recordAttached(CARETAKER_NAME);
  attachOrSwitch(agent.tmuxSession);
}
