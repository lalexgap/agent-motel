import { agentProvider, listAgents, resolveAgent, type AgentState } from "../state";
import { readSubagents, subagentActivity, type SubagentRecord } from "../subagents";
import { formatDuration } from "./hook";
import { displayStatus, relativeTime } from "./ls";

// `am subagents` — the in-session fan-out an agent's pane only hints at. With
// a name: that agent's subagents, running ones first. Without: every agent
// that has any running right now.

export interface SubagentLine {
  icon: string;
  type: string;
  id: string;
  age: string;
  detail: string;
}

function ageOf(record: SubagentRecord, now: number): string {
  const end = record.endedAt ? Date.parse(record.endedAt) : now;
  return formatDuration(Math.max(0, (end - Date.parse(record.startedAt)) / 1000));
}

// Running subagents show what they're doing (from the parent transcript);
// finished ones show what they answered. A record can only still be open on a
// LIVE agent: a killed session fires no Stop hook, so its open records are
// stale and must not read as running. Pure, so the shape is testable.
export function subagentLines(
  records: SubagentRecord[],
  activity: Map<string, string>,
  now = Date.now(),
  opts: { live?: boolean } = {},
): SubagentLine[] {
  const live = opts.live ?? true;
  const running = records.filter((r) => !r.endedAt);
  const finished = records.filter((r) => r.endedAt).reverse();
  return [...running, ...finished].map((record) => {
    if (!record.endedAt && !live) {
      return { icon: "✕", type: record.type, id: record.id.slice(0, 8), age: ageOf(record, now), detail: "ended with the session" };
    }
    return {
      icon: record.endedAt ? "✔" : "●",
      type: record.type,
      id: record.id.slice(0, 8),
      age: ageOf(record, now),
      detail: (record.endedAt ? record.message : activity.get(record.id)) ?? "—",
    };
  });
}

// A gone agent's open records are leftovers, not work in flight — say so in
// the JSON too, so a script reading it draws the same conclusion the table
// shows. Pure.
export function jsonRecords(records: SubagentRecord[], live: boolean): (SubagentRecord & { stale?: true })[] {
  if (live) return records;
  return records.map((record) => (record.endedAt ? record : { ...record, stale: true as const }));
}

interface ColumnWidths {
  type: number;
  id: number;
  age: number;
}

// Widths come from every row that will be printed, so a host-wide listing's
// single header lines up with all of its groups — not just the first.
export function columnWidths(lines: SubagentLine[]): ColumnWidths {
  return {
    type: Math.max(4, ...lines.map((l) => l.type.length)),
    id: Math.max(2, ...lines.map((l) => l.id.length)),
    age: Math.max(3, ...lines.map((l) => l.age.length)),
  };
}

export function subagentHeader(w: ColumnWidths): string {
  return `  ${"TYPE".padEnd(w.type)}  ${"ID".padEnd(w.id)}  ${"AGE".padEnd(w.age)}  DETAIL`;
}

export function subagentRows(lines: SubagentLine[], w: ColumnWidths, width = 60): string[] {
  return lines.map((line) => {
    const detail = line.detail.length > width ? line.detail.slice(0, width - 1) + "…" : line.detail;
    return `${line.icon} ${line.type.padEnd(w.type)}  ${line.id.padEnd(w.id)}  ${line.age.padEnd(w.age)}  ${detail}`;
  });
}

export function formatSubagentLines(lines: SubagentLine[], width = 60): string[] {
  const w = columnWidths(lines);
  return [subagentHeader(w), ...subagentRows(lines, w, width)];
}

// A gone session can't be running anything, whatever its ledger still says.
function agentIsLive(agent: AgentState): boolean {
  const status = displayStatus(agent);
  return status !== "dead" && status !== "exited";
}

function agentReport(agent: AgentState): string[] {
  const records = readSubagents(agent.name);
  if (records.length === 0) {
    const hint = agentProvider(agent) === "codex" ? "" : " (its Task-tool runs appear here)";
    return [`${agent.name}: no subagents recorded${hint}`];
  }
  const live = agentIsLive(agent);
  const open = records.filter((r) => !r.endedAt);
  const activity = live ? subagentActivity(agent, open) : new Map<string, string>();
  return formatSubagentLines(subagentLines(records, activity, Date.now(), { live }));
}

export function subagentsCommand(prefix: string | undefined, opts: { json?: boolean } = {}): void {
  if (prefix) {
    const agent = resolveAgent(prefix);
    const records = readSubagents(agent.name);
    if (opts.json) {
      console.log(JSON.stringify(jsonRecords(records, agentIsLive(agent)), null, 2));
      return;
    }
    console.log(agentReport(agent).join("\n"));
    return;
  }

  // Host-wide view: only what's running right now — finished subagents belong
  // to their agent's own listing, not a cross-agent feed. Gone agents are
  // skipped: their open records are leftovers from a session that was killed
  // before any Stop hook could close them.
  const running = listAgents()
    .filter(agentIsLive)
    .map((agent) => ({ agent, records: readSubagents(agent.name).filter((r) => !r.endedAt) }))
    .filter((entry) => entry.records.length > 0);
  if (opts.json) {
    console.log(
      JSON.stringify(
        running.map((e) => ({ agent: e.agent.name, subagents: e.records })),
        null,
        2,
      ),
    );
    return;
  }
  if (running.length === 0) {
    console.log("no subagents running — `am subagents <name>` shows an agent's finished ones");
    return;
  }
  // One header for the whole listing, sized over every group's rows: each
  // agent's rows sit under its own name, so per-group headers would be noise
  // and a header sized to the first group would leave the rest misaligned.
  const groups = running.map(({ agent, records }) => ({
    agent,
    lines: subagentLines(records, subagentActivity(agent, records)),
  }));
  const widths = columnWidths(groups.flatMap((g) => g.lines));
  const lines: string[] = [subagentHeader(widths)];
  for (const group of groups) {
    lines.push(`${group.agent.name}  ${relativeTime(group.agent.updatedAt)}`);
    lines.push(...subagentRows(group.lines, widths), "");
  }
  console.log(lines.join("\n").trimEnd());
}
