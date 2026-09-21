import { agentProvider, listAgents, resolveAgent, type AgentState } from "../state";
import { readSubagents, subagentActivity, type SubagentRecord } from "../subagents";
import { formatDuration } from "./hook";
import { relativeTime } from "./ls";

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
// finished ones show what they answered. Pure, so the shape is testable.
export function subagentLines(
  records: SubagentRecord[],
  activity: Map<string, string>,
  now = Date.now(),
): SubagentLine[] {
  const running = records.filter((r) => !r.endedAt);
  const finished = records.filter((r) => r.endedAt).reverse();
  return [...running, ...finished].map((record) => ({
    icon: record.endedAt ? "✔" : "●",
    type: record.type,
    id: record.id.slice(0, 8),
    age: ageOf(record, now),
    detail: (record.endedAt ? record.message : activity.get(record.id)) ?? "—",
  }));
}

export function formatSubagentLines(lines: SubagentLine[], width = 60): string[] {
  const typeWidth = Math.max(4, ...lines.map((l) => l.type.length));
  const idWidth = Math.max(2, ...lines.map((l) => l.id.length));
  const ageWidth = Math.max(3, ...lines.map((l) => l.age.length));
  const out = [
    `  ${"TYPE".padEnd(typeWidth)}  ${"ID".padEnd(idWidth)}  ${"AGE".padEnd(ageWidth)}  DETAIL`,
  ];
  for (const line of lines) {
    const detail = line.detail.length > width ? line.detail.slice(0, width - 1) + "…" : line.detail;
    out.push(
      `${line.icon} ${line.type.padEnd(typeWidth)}  ${line.id.padEnd(idWidth)}  ${line.age.padEnd(ageWidth)}  ${detail}`,
    );
  }
  return out;
}

function agentReport(agent: AgentState): string[] {
  const records = readSubagents(agent.name);
  if (records.length === 0) {
    const hint = agentProvider(agent) === "codex" ? "" : " (its Task-tool runs appear here)";
    return [`${agent.name}: no subagents recorded${hint}`];
  }
  return formatSubagentLines(subagentLines(records, subagentActivity(agent)));
}

export function subagentsCommand(prefix: string | undefined, opts: { json?: boolean } = {}): void {
  if (prefix) {
    const agent = resolveAgent(prefix);
    const records = readSubagents(agent.name);
    if (opts.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    console.log(agentReport(agent).join("\n"));
    return;
  }

  // Fleet view: only what's running right now — finished subagents belong to
  // their agent's own listing, not a cross-agent feed.
  const running = listAgents()
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
  const lines: string[] = [];
  for (const { agent, records } of running) {
    lines.push(`${agent.name}  ${relativeTime(agent.updatedAt)}`);
    lines.push(...formatSubagentLines(subagentLines(records, subagentActivity(agent))).slice(1));
    lines.push("");
  }
  console.log(lines.join("\n").trimEnd());
}
