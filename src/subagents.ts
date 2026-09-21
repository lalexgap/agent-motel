import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { subagentsDir, subagentsFile } from "./paths";
import { readFileTail } from "./fsutil";
import { agentProvider, type AgentState } from "./state";
import { locateTranscript } from "./transcript";

// In-session subagents (Claude Code's Task tool, Codex's subagents) run inside
// the parent provider process: no tmux session of their own, and the pane
// collapses each one to a single line. Both providers do fire
// SubagentStart/SubagentStop hooks, so `am hook` appends them to a per-agent
// JSONL ledger here. That's the whole visibility story for them — the sidebar
// rolls up what's running, `am subagents` lists the detail, and
// `am transcript --subagent` reads the conversation afterwards.
//
// Append-only on purpose: several hook processes (one per subagent) write
// concurrently, and a small O_APPEND line can't interleave the way a
// read-modify-write of one JSON document would.

export interface SubagentRecord {
  id: string;
  // "Explore", "general-purpose", a custom agent name — whatever the provider
  // reports as agent_type.
  type: string;
  startedAt: string;
  endedAt?: string;
  // last_assistant_message from the stop hook: the subagent's answer, capped.
  message?: string;
  // agent_transcript_path: its own conversation file, when the provider gives
  // one. Absent for a subagent still running (or closed out by a turn end).
  transcriptPath?: string;
}

type LedgerEvent =
  | { ev: "start"; id: string; type?: string; at: string }
  | { ev: "stop"; id: string; type?: string; at: string; msg?: string; transcript?: string }
  // A turn boundary closes every subagent still open: they cannot outlive the
  // parent's turn, and an interrupted turn fires no stop hook of its own.
  | { ev: "turn-end"; at: string };

const MESSAGE_CHARS = 200;
const KEEP_FINISHED = 20;
const COMPACT_BYTES = 64_000;

export const UNKNOWN_TYPE = "subagent";

// The stop hook's last_assistant_message is a whole reply. Keep one line, so
// the ledger stays small and every append stays atomic.
export function clipMessage(text: string, max = MESSAGE_CHARS): string {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function append(name: string, event: LedgerEvent): void {
  mkdirSync(subagentsDir(), { recursive: true });
  appendFileSync(subagentsFile(name), JSON.stringify(event) + "\n");
}

export function recordSubagentStart(
  name: string,
  sub: { id: string; type?: string; at?: string },
): void {
  append(name, { ev: "start", id: sub.id, type: sub.type, at: sub.at ?? new Date().toISOString() });
  compactIfLarge(name);
}

export function recordSubagentStop(
  name: string,
  sub: { id: string; type?: string; message?: string; transcriptPath?: string; at?: string },
): void {
  append(name, {
    ev: "stop",
    id: sub.id,
    type: sub.type,
    at: sub.at ?? new Date().toISOString(),
    msg: sub.message ? clipMessage(sub.message) : undefined,
    transcript: sub.transcriptPath,
  });
  compactIfLarge(name);
}

// Called at a turn boundary (stop / session-end). Cheap no-op when nothing is
// open, so it can run on every turn without growing the file.
export function closeOpenSubagents(name: string, at = new Date().toISOString()): void {
  if (!existsSync(subagentsFile(name))) return;
  if (readSubagents(name).every((r) => r.endedAt)) return;
  append(name, { ev: "turn-end", at });
}

function parseEvents(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as LedgerEvent;
      if (event && typeof event.ev === "string") events.push(event);
    } catch {
      // A hook can be mid-write on the last line.
    }
  }
  return events;
}

// Fold the ledger into records, oldest start first. Pure, so the fold is
// testable without touching disk.
export function foldEvents(events: LedgerEvent[]): SubagentRecord[] {
  const byId = new Map<string, SubagentRecord>();
  for (const event of events) {
    if (event.ev === "turn-end") {
      for (const record of byId.values()) {
        if (!record.endedAt) record.endedAt = event.at;
      }
      continue;
    }
    if (typeof event.id !== "string" || !event.id) continue;
    const record = byId.get(event.id) ?? {
      id: event.id,
      type: event.type || UNKNOWN_TYPE,
      startedAt: event.at,
    };
    if (event.type) record.type = event.type;
    if (event.ev === "start") {
      // A provider that reuses an id starts a NEW run: without this the
      // record stays closed and never reads as running again.
      record.startedAt = event.at;
      record.endedAt = undefined;
      record.message = undefined;
      record.transcriptPath = undefined;
    } else {
      record.endedAt = event.at;
      if (event.msg) record.message = event.msg;
      if (event.transcript) record.transcriptPath = event.transcript;
    }
    byId.set(event.id, record);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function readSubagents(name: string): SubagentRecord[] {
  const file = subagentsFile(name);
  if (!existsSync(file)) return [];
  try {
    return foldEvents(parseEvents(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

export function activeSubagents(name: string): SubagentRecord[] {
  return readSubagents(name).filter((r) => !r.endedAt);
}

// Rewrite the ledger as one start(+stop) pair per surviving record once it
// grows past the cap: everything still open, plus the most recent finished
// ones. A concurrent append can lose at most its own line to the rename,
// which costs one subagent row and never corrupts the file.
function compactIfLarge(name: string): void {
  const file = subagentsFile(name);
  try {
    if (statSync(file).size < COMPACT_BYTES) return;
  } catch {
    return;
  }
  sweepStaleTemps();
  const records = readSubagents(name);
  const open = records.filter((r) => !r.endedAt);
  const finished = records.filter((r) => r.endedAt).slice(-KEEP_FINISHED);
  const kept = [...open, ...finished].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const lines: string[] = [];
  for (const record of kept) {
    lines.push(JSON.stringify({ ev: "start", id: record.id, type: record.type, at: record.startedAt }));
    if (record.endedAt) {
      lines.push(
        JSON.stringify({
          ev: "stop",
          id: record.id,
          type: record.type,
          at: record.endedAt,
          msg: record.message,
          transcript: record.transcriptPath,
        }),
      );
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, lines.join("\n") + "\n");
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

const TEMP_GRACE_MS = 60 * 60 * 1000;

// A hook killed between the write and the rename leaves its temp behind, and
// gc only knows about .jsonl files — so compaction clears old ones itself.
function sweepStaleTemps(): void {
  try {
    for (const f of readdirSync(subagentsDir())) {
      if (!f.endsWith(".tmp")) continue;
      const path = join(subagentsDir(), f);
      if (Date.now() - statSync(path).mtimeMs > TEMP_GRACE_MS) rmSync(path, { force: true });
    }
  } catch {
    // best effort — a failed sweep must never block a ledger write
  }
}

export interface SubagentSummary {
  active: number;
  // The types running, capped: "Explore, code-review +2".
  types: string;
  // Display-ready rollup for the status column: "2 subagents · Explore".
  detail: string;
}

// The types of what's running, most recent first, capped so a wide fan-out
// still fits a status column. Pure.
export function summarize(records: SubagentRecord[]): SubagentSummary | null {
  const open = records.filter((r) => !r.endedAt);
  if (open.length === 0) return null;
  const types: string[] = [];
  for (const record of [...open].reverse()) {
    if (!types.includes(record.type)) types.push(record.type);
  }
  const shown = types.slice(0, 2).join(", ") + (types.length > 2 ? ` +${types.length - 2}` : "");
  const noun = open.length === 1 ? "subagent" : "subagents";
  return { active: open.length, types: shown, detail: `${open.length} ${noun} · ${shown}` };
}

export function subagentSummary(name: string): SubagentSummary | null {
  return summarize(readSubagents(name));
}

export function subagentsExist(name: string): boolean {
  return existsSync(subagentsFile(name));
}

export function removeSubagents(name: string): void {
  rmSync(subagentsFile(name), { force: true });
}

export function renameSubagents(oldName: string, newName: string): void {
  if (subagentsExist(newName)) {
    throw new Error(`subagent ledger already exists for "${newName}" — run \`am gc\` or choose another name`);
  }
  if (subagentsExist(oldName)) renameSync(subagentsFile(oldName), subagentsFile(newName));
}

// Every stored ledger with the agent it belongs to, for `am gc`'s orphan scan.
export function listSubagentLedgers(): { name: string; path: string }[] {
  if (!existsSync(subagentsDir())) return [];
  const out: { name: string; path: string }[] = [];
  for (const f of readdirSync(subagentsDir())) {
    if (f.endsWith(".jsonl")) out.push({ name: f.slice(0, -".jsonl".length), path: join(subagentsDir(), f) });
  }
  return out;
}

const ACTIVITY_TAIL_BYTES = 96_000;
const ACTIVITY_CHARS = 72;

// Claude Code gives each subagent its own transcript beside the parent's:
//   <projects>/<slug>/<parent-session-id>/subagents/agent-<agent_id>.jsonl
// The stop hook reports that path, but only once the subagent has finished —
// while it runs, the id from the start hook is enough to derive it. Null when
// the parent's own transcript can't be located.
export function subagentTranscriptFile(agent: AgentState, subagentId: string): string | null {
  let parent: string;
  try {
    parent = locateTranscript(agent);
  } catch {
    return null; // no session file yet
  }
  const sessionDir = join(dirname(parent), basename(parent, ".jsonl"));
  return join(sessionDir, "subagents", `agent-${subagentId}.jsonl`);
}

// What each of the given subagents is doing right now, keyed by id. Codex
// reports no transcript until its subagent stops, so codex agents get
// lifecycle without a live line.
export function subagentActivity(agent: AgentState, records: SubagentRecord[]): Map<string, string> {
  const activity = new Map<string, string>();
  if (agentProvider(agent) !== "claude") return activity;
  for (const record of records) {
    const file = record.transcriptPath ?? subagentTranscriptFile(agent, record.id);
    if (!file) continue;
    const text = readFileTail(file, ACTIVITY_TAIL_BYTES);
    if (!text) continue;
    let described: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"assistant"')) continue; // cheap reject before JSON.parse
      try {
        described = describeSidechainEntry(JSON.parse(line)) ?? described;
      } catch {
        // a live subagent can be mid-write on its last line
      }
    }
    if (described) activity.set(record.id, described);
  }
  return activity;
}

// The last thing a subagent turn shows: its own words, or the tool it reached
// for. Tool results and harness noise say nothing useful at a glance.
function describeSidechainEntry(entry: Record<string, any>): string | null {
  if (entry.type !== "assistant") return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  let described: string | null = null;
  for (const block of content) {
    if (block.type === "text" && block.text?.trim()) {
      described = clipMessage(block.text, ACTIVITY_CHARS);
    } else if (block.type === "tool_use") {
      const input = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? "");
      described = clipMessage(`${block.name ?? "tool"} ${input}`, ACTIVITY_CHARS);
    }
  }
  return described;
}
