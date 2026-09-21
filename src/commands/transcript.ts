import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { agentProvider, resolveAgent, type AgentState } from "../state";
import { locateTranscript, parseTranscript, renderTranscript, type ParseOpts } from "../transcript";
import { readSubagents, type SubagentRecord } from "../subagents";

// A subagent is addressed by id (or an unambiguous prefix of one) or by type,
// where the most recent run of that type wins — ids are uuids nobody types.
export function matchSubagent(records: SubagentRecord[], query: string): SubagentRecord | null {
  const exact = records.find((r) => r.id === query);
  if (exact) return exact;
  const byId = records.filter((r) => r.id.startsWith(query));
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) throw new Error(`"${query}" matches ${byId.length} subagents — use a longer id`);
  const byType = records.filter((r) => r.type.toLowerCase() === query.toLowerCase());
  return byType.length > 0 ? byType[byType.length - 1]! : null;
}

function subagentSource(agent: AgentState, query: string): { file: string; opts: ParseOpts; label: string } {
  const records = readSubagents(agent.name);
  if (records.length === 0) {
    throw new Error(`agent "${agent.name}" has no recorded subagents`);
  }
  const record = matchSubagent(records, query);
  if (!record) {
    const known = [...new Set(records.map((r) => r.type))].join(", ");
    throw new Error(`no subagent matches "${query}" — ${agent.name} has: ${known}`);
  }
  const label = `${agent.name} ⤷ ${record.type}`;
  // A finished subagent has its own transcript file.
  if (record.transcriptPath && existsSync(record.transcriptPath)) {
    return { file: record.transcriptPath, opts: { sidechain: { ownFile: true } }, label };
  }
  // Still running: claude writes its turns into the parent's session file,
  // tagged with the agent id. Codex doesn't, so there is nothing to render
  // until it finishes and reports its own transcript.
  if (agentProvider(agent) === "codex") {
    throw new Error(
      `codex keeps subagent turns out of the parent session — "${record.type}" has no transcript of its own yet (it is still running)`,
    );
  }
  return { file: locateTranscript(agent), opts: { sidechain: { agentId: record.id } }, label };
}

export function transcriptCommand(
  prefix: string,
  opts: { full?: boolean; out?: string; subagent?: string },
): void {
  const agent = resolveAgent(prefix);
  const source = opts.subagent
    ? subagentSource(agent, opts.subagent)
    : { file: locateTranscript(agent), opts: {} as ParseOpts, label: agent.name };
  const transcript = parseTranscript(agentProvider(agent), readFileSync(source.file, "utf8"), source.opts);
  const markdown = renderTranscript(transcript, { full: opts.full, agentName: source.label });
  if (opts.out) {
    writeFileSync(opts.out, markdown);
    console.log(`wrote ${opts.out}`);
  } else {
    console.log(markdown);
  }
}
