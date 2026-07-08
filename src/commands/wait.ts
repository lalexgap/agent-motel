import { readAgent, resolveAgent } from "../state";
import { displayStatus, STATUS_ICONS, type DisplayStatus } from "./ls";
import { formatDuration } from "./hook";
import { finalAssistantText, waitForTurn } from "./run";

// `am wait <name>`: block until an EXISTING agent finishes its turn — the
// orchestration primitive that pairs with `am send`:
//   am send api "fix the tests" && am wait api
// prints api's final message when the turn ends, so a send/wait pair works
// like a request/response. `--status <s>` waits for a specific display
// status instead (e.g. needs-attention in a watchdog script).

const POLL_MS = 500;

// Derived from the icon table (a Record over DisplayStatus, so a new status
// can't be forgotten here without a type error there).
const STATUSES = Object.keys(STATUS_ICONS) as DisplayStatus[];

// "waiting" is idle-with-a-scheduled-wake-up (a pane-scrape refinement) — a
// caller asking for idle means "not busy", which waiting satisfies; without
// this, `--status idle` could flap against the scrape and never match.
export function statusMatches(actual: DisplayStatus, want: DisplayStatus): boolean {
  return actual === want || (want === "idle" && actual === "waiting");
}

export type StatusWaitOutcome = "reached" | "removed" | "timeout";

export async function waitForStatus(
  name: string,
  status: DisplayStatus,
  timeoutMs: number,
): Promise<StatusWaitOutcome> {
  const start = Date.now();
  do {
    const agent = readAgent(name);
    if (!agent) return "removed";
    if (statusMatches(displayStatus(agent), status)) return "reached";
    await Bun.sleep(POLL_MS);
  } while (Date.now() - start < timeoutMs);
  return "timeout";
}

export interface WaitOptions {
  status?: string;
  timeoutSec?: number;
  // Suppress printing the agent's final message on a completed turn.
  quiet?: boolean;
}

export async function waitCommand(prefix: string, opts: WaitOptions): Promise<void> {
  const agent = resolveAgent(prefix);
  const timeoutSec = opts.timeoutSec ?? 600;
  const timeoutMs = timeoutSec * 1000;

  if (opts.status) {
    if (!STATUSES.includes(opts.status as DisplayStatus)) {
      throw new Error(`unknown status "${opts.status}" — one of: ${STATUSES.join(", ")}`);
    }
    const outcome = await waitForStatus(agent.name, opts.status as DisplayStatus, timeoutMs);
    if (outcome === "reached") {
      console.log(`${agent.name}: ${opts.status}`);
      return;
    }
    console.error(
      outcome === "removed"
        ? `[am] ${agent.name}: agent was removed while waiting`
        : `[am] ${agent.name}: not ${opts.status} after ${formatDuration(timeoutSec)}`,
    );
    process.exitCode = 1;
    return;
  }

  // Default: wait for the current (or queued-and-about-to-start) turn to
  // finish — the same collect semantics as `am run`, including the graces
  // that keep a message still in flight from reading as a finished turn.
  // Snapshot the last answer FIRST: only text that changed during this wait
  // is printed, so a wait that observed no new turn (bare wait on an idle
  // agent, a delivery that never submitted) can't reprint a previous
  // answer as if it were fresh.
  const before = finalAssistantText(agent);
  const outcome = await waitForTurn(agent.name, timeoutMs);
  if (outcome !== "done") {
    const after = readAgent(agent.name);
    console.error(`[am] ${agent.name}: ${outcome}${after ? ` (status ${after.status})` : ""}`);
    process.exitCode = 1;
    return;
  }
  if (opts.quiet) return;
  const after = readAgent(agent.name);
  const text = after ? finalAssistantText(after) : "";
  if (text && text !== before) console.log(text);
}
