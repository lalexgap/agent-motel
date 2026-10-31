import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  agentProvider,
  agentSessionId,
  resolveAgent,
  type AgentState,
  type Provider,
} from "../state";
import {
  locateTranscript,
  parseTranscript,
  renderTranscript,
  type ParseOpts,
  type Turn,
} from "../transcript";
import { displayStatus } from "./ls";
import {
  readSubagents,
  subagentTranscriptFile,
  type SubagentRecord,
} from "../subagents";

// A subagent is addressed by id (or an unambiguous prefix of one) or by type,
// where the most recent run of that type wins — ids are uuids nobody types.
export function matchSubagent(
  records: SubagentRecord[],
  query: string,
): SubagentRecord | null {
  const exact = records.find((r) => r.id === query);
  if (exact) return exact;
  const byId = records.filter((r) => r.id.startsWith(query));
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1)
    throw new Error(
      `"${query}" matches ${byId.length} subagents — use a longer id`,
    );
  const byType = records.filter(
    (r) => r.type.toLowerCase() === query.toLowerCase(),
  );
  return byType.length > 0 ? byType[byType.length - 1]! : null;
}

interface TranscriptSource {
  file: string;
  opts: ParseOpts;
  label: string;
  // Why the subagent's own transcript wasn't used, for the error when the
  // fallback to the parent's session file turns up nothing.
  missing?: string;
}

function subagentSource(agent: AgentState, query: string): TranscriptSource {
  if (agentProvider(agent) === "antigravity") throw new Error("Antigravity subagent transcripts are unsupported");
  const records = readSubagents(agent.name);
  if (records.length === 0) {
    throw new Error(`agent "${agent.name}" has no recorded subagents`);
  }
  const record = matchSubagent(records, query);
  if (!record) {
    const known = [...new Set(records.map((r) => r.type))].join(", ");
    throw new Error(
      `no subagent matches "${query}" — ${agent.name} has: ${known}`,
    );
  }
  const label = `${agent.name} ⤷ ${record.type}`;
  // A finished subagent has its own transcript file.
  if (record.transcriptPath && existsSync(record.transcriptPath)) {
    return {
      file: record.transcriptPath,
      opts: { sidechain: { ownFile: true } },
      label,
    };
  }
  const missing = record.transcriptPath
    ? `its transcript ${record.transcriptPath} is gone`
    : record.endedAt
      ? "it finished without reporting one"
      : "it is still running";
  // Only the stop hook reports that path, so a running claude subagent needs
  // it derived from its id. Codex reports nothing until its subagent stops.
  if (agentProvider(agent) === "codex") {
    throw new Error(
      `codex keeps subagent turns out of the parent session — "${record.type}" has no transcript of its own (${missing})`,
    );
  }
  const live = subagentTranscriptFile(agent, record.id);
  if (live && existsSync(live)) {
    return { file: live, opts: { sidechain: { ownFile: true } }, label };
  }
  // Older transcripts kept subagent turns inline in the parent's file.
  return {
    file: locateTranscript(agent),
    opts: { sidechain: { agentId: record.id } },
    label,
    missing,
  };
}

export type TranscriptEntry = Turn & { index: number };

export interface TranscriptJson {
  provider: Provider;
  sessionId: string | null;
  status: string;
  total: number;
  entries: TranscriptEntry[];
}

// Indexes are positions in the full parsed turn list. A tool entry's output can
// land later, so `after` pollers re-read from their oldest unsettled index.
export function transcriptJson(agent: AgentState, after = 0): TranscriptJson {
  const provider = agentProvider(agent);
  let file: string | null = null;
  try {
    file = locateTranscript(agent);
  } catch {
    // No session id or no file yet: the agent hasn't produced a turn.
  }
  const transcript =
    file && existsSync(file)
      ? parseTranscript(provider, readFileSync(file, "utf8"))
      : null;
  const turns = transcript?.turns ?? [];
  return {
    provider,
    sessionId: agentSessionId(agent) ?? transcript?.sessionId ?? null,
    status: displayStatus(agent),
    total: turns.length,
    entries: turns
      .slice(Math.max(0, after))
      .map((turn, i) => ({ index: Math.max(0, after) + i, ...turn })),
  };
}

export function subagentTranscriptJson(
  agent: AgentState,
  query: string,
  after = 0,
): TranscriptJson {
  const source = subagentSource(agent, query);
  const provider = agentProvider(agent);
  const transcript = parseTranscript(
    provider,
    readFileSync(source.file, "utf8"),
    source.opts,
  );
  const record = matchSubagent(readSubagents(agent.name), query)!;
  return {
    provider,
    sessionId: transcript.sessionId ?? null,
    status: record.endedAt ? "exited" : displayStatus(agent),
    total: transcript.turns.length,
    entries: transcript.turns
      .slice(after)
      .map((turn, i) => ({ index: after + i, ...turn })),
  };
}

export function transcriptCommand(
  prefix: string,
  opts: { full?: boolean; out?: string; subagent?: string; json?: boolean },
): void {
  const agent = resolveAgent(prefix);
  if (opts.json) {
    const out = JSON.stringify(
      opts.subagent
        ? subagentTranscriptJson(agent, opts.subagent)
        : transcriptJson(agent),
      null,
      2,
    );
    if (opts.out) {
      writeFileSync(opts.out, out + "\n");
      console.log(`wrote ${opts.out}`);
    } else {
      console.log(out);
    }
    return;
  }
  const source: TranscriptSource = opts.subagent
    ? subagentSource(agent, opts.subagent)
    : { file: locateTranscript(agent), opts: {}, label: agent.name };
  const transcript = parseTranscript(
    agentProvider(agent),
    readFileSync(source.file, "utf8"),
    source.opts,
  );
  // Reading the parent's file and matching nothing means the subagent's turns
  // aren't identifiable there — an empty render would look like an empty
  // conversation instead of a failed lookup.
  if (opts.subagent && transcript.turns.length === 0) {
    throw new Error(
      `no turns found for "${opts.subagent}" in ${source.file}` +
        `${source.missing ? ` (${source.missing})` : ""} — it may not have produced a turn yet`,
    );
  }
  const markdown = renderTranscript(transcript, {
    full: opts.full,
    agentName: source.label,
  });
  if (opts.out) {
    writeFileSync(opts.out, markdown);
    console.log(`wrote ${opts.out}`);
  } else {
    console.log(markdown);
  }
}
