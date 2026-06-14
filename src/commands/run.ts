import { readFileSync } from "node:fs";
import { readAgent, agentProvider, type AgentState, type Provider } from "../state";
import { queueDepth } from "../queue";
import { locateTranscript, parseTranscript } from "../transcript";
import { destroyAgent } from "./rm";
import { newCommand } from "./new";

export interface RunOptions {
  message: string;
  dir?: string;
  worktree?: string;
  provider?: Provider;
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

// The last thing the agent said — the natural "return value" of a one-shot
// task, mirroring how the Agent tool surfaces a subagent's final message.
export function finalAssistantText(agent: AgentState): string {
  let jsonl: string;
  try {
    jsonl = readFileSync(locateTranscript(agent), "utf8");
  } catch {
    return "";
  }
  const transcript = parseTranscript(agentProvider(agent), jsonl);
  for (let i = transcript.turns.length - 1; i >= 0; i--) {
    const turn = transcript.turns[i]!;
    if (turn.kind === "assistant" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

const POLL_MS = 500;
// A task turn that never reports "working" (a trivial prompt that finishes
// inside one poll window) is still treated as done once it sits idle with an
// empty queue past this grace — so a fast agent doesn't read as a timeout.
const FAST_IDLE_GRACE_MS = 8000;

// Wait for a freshly-spawned agent to finish the turn its -m message kicked
// off. Spawn status flows starting -> idle (SessionStart) -> working (prompt
// delivered) -> idle (Stop); we must not mistake the SessionStart idle for
// completion, so we wait until it has actually gone "working" first (or sat
// idle-and-drained past the grace, for turns too fast to observe).
export async function waitForTurn(name: string, timeoutMs: number): Promise<RunResult["outcome"]> {
  const start = Date.now();
  let sawWorking = false;
  let idleSince: number | null = null;

  while (Date.now() - start < timeoutMs) {
    const agent = readAgent(name);
    if (!agent) return "exited"; // removed out from under us
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
          if (sawWorking) return "done";
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= FAST_IDLE_GRACE_MS) return "done";
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
