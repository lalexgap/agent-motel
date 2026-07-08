import { readFileSync } from "node:fs";
import { readAgent, agentProvider, type AgentState, type Provider } from "../state";
import { queueDepth } from "../queue";
import { hasSession } from "../tmux";
import { locateTranscript, parseTranscript } from "../transcript";
import { readFileTail } from "../fsutil";
import { destroyAgent } from "./rm";
import { newCommand } from "./new";

export interface RunOptions {
  message: string;
  dir?: string;
  worktree?: string;
  provider?: Provider;
  model?: string;
  effort?: string;
  // Seconds to wait for the task turn to finish before giving up. The agent
  // keeps running on timeout (it's a real agent) — only the wait gives up.
  timeoutSec?: number;
  // Tear the agent down once its result is collected. Default keeps it alive
  // and visible (the whole point: a first-class am agent you can attach to).
  rm?: boolean;
  json?: boolean;
}

export interface RunResult {
  name: string;
  // "done" = finished its turn; "blocked" = waiting on the user (approval /
  // input); "exited" = the session ended; "timeout" = still working when we
  // stopped waiting.
  outcome: "done" | "blocked" | "exited" | "timeout";
  status: AgentState["status"];
  result: string;
}

const TRANSCRIPT_TAIL_BYTES = 262_144;

function lastAssistantIn(provider: Provider, jsonl: string): string {
  const transcript = parseTranscript(provider, jsonl);
  for (let i = transcript.turns.length - 1; i >= 0; i--) {
    const turn = transcript.turns[i]!;
    if (turn.kind === "assistant" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

// The last thing the agent said — the natural "return value" of a one-shot
// task, mirroring how the Agent tool surfaces a subagent's final message.
// Long-lived agents' transcripts reach 100MB+ and `am wait` reads this per
// invocation, so parse the tail first (JSONL lines are independent) and fall
// back to the full file only when the tail holds no assistant text.
export function finalAssistantText(agent: AgentState): string {
  let path: string;
  try {
    path = locateTranscript(agent);
  } catch {
    return "";
  }
  const provider = agentProvider(agent);
  const tail = readFileTail(path, TRANSCRIPT_TAIL_BYTES);
  if (tail) {
    const text = lastAssistantIn(provider, tail);
    if (text) return text;
  }
  try {
    return lastAssistantIn(provider, readFileSync(path, "utf8"));
  } catch {
    return "";
  }
}

const POLL_MS = 500;
// A task turn that never reports "working" (a trivial prompt that finishes
// inside one poll window) is still treated as done once it sits idle with an
// empty queue past this grace — so a fast agent doesn't read as a timeout.
const FAST_IDLE_GRACE_MS = 8000;
// After a watched turn ends, idle+drained must HOLD briefly before "done": a
// message delivered at the stop boundary leaves a short idle gap before its
// user-prompt-submit hook flips status back to working — returning instantly
// there would report the PREVIOUS turn's answer as the result.
const POST_TURN_GRACE_MS = 2500;

// Grace overrides exist for tests; production callers take the defaults.
export interface TurnWaitOpts {
  fastIdleGraceMs?: number;
  postTurnGraceMs?: number;
}

// Wait for an agent to finish its current (or queued-and-about-to-start)
// turn. Spawn status flows starting -> idle (SessionStart) -> working (prompt
// delivered) -> idle (Stop); we must not mistake the SessionStart idle for
// completion, so we wait until it has actually gone "working" first (or sat
// idle-and-drained past the grace, for turns too fast to observe). Also used
// by `am wait` on pre-existing agents, so a dead session must fail fast — the
// state file is frozen and no hook will ever move it again.
export async function waitForTurn(
  name: string,
  timeoutMs: number,
  opts: TurnWaitOpts = {},
): Promise<RunResult["outcome"]> {
  const fastIdleGraceMs = opts.fastIdleGraceMs ?? FAST_IDLE_GRACE_MS;
  const postTurnGraceMs = opts.postTurnGraceMs ?? POST_TURN_GRACE_MS;
  const start = Date.now();
  let sawWorking = false;
  let idleSince: number | null = null;

  while (Date.now() - start < timeoutMs) {
    const agent = readAgent(name);
    if (!agent) return "exited"; // removed out from under us
    if (agent.status !== "exited" && !hasSession(agent.tmuxSession)) {
      return "exited"; // session gone (reboot, kill) — the status can't change
    }
    const drained = queueDepth(name) === 0;

    switch (agent.status) {
      case "working":
      case "starting":
        sawWorking = sawWorking || agent.status === "working";
        idleSince = null;
        break;
      case "needs-attention":
        return "blocked";
      case "exited":
        return "exited";
      case "idle":
        if (drained) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= (sawWorking ? postTurnGraceMs : fastIdleGraceMs)) {
            return "done";
          }
        } else {
          idleSince = null; // message still queued; the turn hasn't begun
        }
        break;
    }
    await Bun.sleep(POLL_MS);
  }
  return "timeout";
}

// Spawn a real, am-visible agent for a one-shot task, wait for it to finish,
// and return its final message. Unlike the in-process Agent/Task tool, the
// agent it creates is a first-class am citizen: it shows in `am ls`, has its
// own tmux session, and can be attached, messaged, or moved.
export async function runAgent(name: string, opts: RunOptions): Promise<RunResult> {
  await newCommand({
    name,
    message: opts.message,
    dir: opts.dir,
    worktree: opts.worktree,
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    jump: false,
    quiet: true,
  });

  const outcome = await waitForTurn(name, (opts.timeoutSec ?? 600) * 1000);
  const agent = readAgent(name);
  const result = agent ? finalAssistantText(agent) : "";

  if (opts.rm && agent) destroyAgent(agent, { clean: !!agent.worktreePath });

  return { name, outcome, status: agent?.status ?? "exited", result };
}

export async function runCommand(name: string, opts: RunOptions): Promise<void> {
  const run = await runAgent(name, opts);

  if (opts.json) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    if (run.outcome !== "done") {
      console.error(`[am] ${name}: ${run.outcome} (status ${run.status})`);
    }
    if (run.result) console.log(run.result);
  }
  // A blocked/timed-out/exited run is a non-zero outcome so scripted callers
  // (orchestrators piping the result) can branch on it.
  if (run.outcome !== "done") process.exitCode = 1;
}
