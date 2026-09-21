import { resolveAgent, type AgentState } from "../state";
import { capturePane, hasSession, stripSgr } from "../tmux";
import { readSnapshot } from "../snapshots";
import { displayStatus } from "./ls";
import { readSubagents, subagentNoOutputNote, subagentScreen, type SubagentRecord } from "../subagents";
import { matchSubagent } from "./transcript";
import { ageOf } from "./subagents";

// `am peek <name>`: print the agent's current screen without attaching — for
// a human over ssh, or an orchestrating agent checking what a peer is doing
// (a transcript is overkill for "what's on its screen right now"). Dead
// agents fall back to their last-screen snapshot.

// Tail + optional SGR strip. Colors stay for a terminal; piped output (an
// agent reading it) gets plain text. Both the live capture and the stored
// snapshot carry colors, so this is the single cleaning point. Pure.
export function formatPeek(lines: string[], opts: { lines?: number; colors: boolean }): string {
  const tail = opts.lines && opts.lines > 0 ? lines.slice(-opts.lines) : lines;
  const text = tail.join("\n");
  return opts.colors ? text : stripSgr(text);
}

const FOLLOW_MS = 2000;

// `am peek <name> --subagent <id|type>`: a subagent has no screen, so its
// transcript stands in — the same lines the hub shows when its row is
// selected. --follow redraws until the subagent finishes, which is what the
// hub's right pane runs (locally, or over ssh exactly like an attach).
async function peekSubagent(
  agent: AgentState,
  query: string,
  opts: { lines?: number; follow?: boolean },
): Promise<void> {
  const find = (): SubagentRecord => {
    const records = readSubagents(agent.name);
    if (records.length === 0) throw new Error(`agent "${agent.name}" has no recorded subagents`);
    const record = matchSubagent(records, query);
    if (!record) {
      const known = [...new Set(records.map((r) => r.type))].join(", ");
      throw new Error(`no subagent matches "${query}" — ${agent.name} has: ${known}`);
    }
    return record;
  };
  let record = find();
  const frame = (): string[] => {
    const body = subagentScreen(agent, record) ?? [subagentNoOutputNote(agent)];
    const tail = opts.lines && opts.lines > 0 ? body.slice(-opts.lines) : body;
    const state = record.endedAt ? " · finished" : "";
    return [`⤷ ${record.type} · ${agent.name} · ${ageOf(record, Date.now())}${state}`, "", ...tail];
  };
  if (!opts.follow) {
    console.log(frame().join("\n"));
    return;
  }
  for (;;) {
    process.stdout.write(`\x1b[2J\x1b[H${frame().join("\n")}\n`);
    if (record.endedAt) {
      if (record.message) console.log(`\n✔ ${record.message}`);
      return;
    }
    await Bun.sleep(FOLLOW_MS);
    record = find();
  }
}

export async function peekCommand(
  prefix: string,
  opts: { lines?: number; subagent?: string; follow?: boolean },
): Promise<void> {
  if (opts.lines !== undefined && (!Number.isInteger(opts.lines) || opts.lines < 0)) {
    throw new Error(`--lines must be a non-negative integer, got ${opts.lines}`);
  }
  const agent = resolveAgent(prefix);
  if (opts.subagent) return peekSubagent(agent, opts.subagent, opts);
  if (opts.follow) throw new Error("--follow applies to --subagent; attach to an agent to watch its screen");
  const colors = !!process.stdout.isTTY;

  // Capture WITH colors regardless of the output target — formatPeek is the
  // one place that strips, so live panes and snapshots clean identically.
  const live = hasSession(agent.tmuxSession) ? capturePane(agent.tmuxSession, { colors: true }) : null;
  if (live) {
    console.log(formatPeek(live, { lines: opts.lines, colors }));
    return;
  }

  const snapshot = readSnapshot(agent.name);
  if (!snapshot) {
    throw new Error(
      `agent "${agent.name}" has no live session and no snapshot (status: ${displayStatus(agent)})`,
    );
  }
  // The provenance note goes to stderr so piped output stays clean screen text.
  console.error(`(last screen — ${displayStatus(agent)})`);
  console.log(formatPeek(snapshot, { lines: opts.lines, colors }));
}
