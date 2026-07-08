import { resolveAgent } from "../state";
import { capturePane, hasSession, stripSgr } from "../tmux";
import { readSnapshot } from "../snapshots";
import { displayStatus } from "./ls";

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

export function peekCommand(prefix: string, opts: { lines?: number }): void {
  if (opts.lines !== undefined && (!Number.isInteger(opts.lines) || opts.lines < 0)) {
    throw new Error(`--lines must be a non-negative integer, got ${opts.lines}`);
  }
  const agent = resolveAgent(prefix);
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
