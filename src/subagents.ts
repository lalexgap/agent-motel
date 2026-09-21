import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { subagentsDir, subagentsFile } from "./paths";
import { readFileTail } from "./fsutil";
import { agentProvider, type AgentState } from "./state";
import { locateTranscript, parseTranscript, type Turn } from "./transcript";

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
  // What it was asked to do, when the provider says: Claude writes the Agent
  // tool's description ("Shepherd PR 74", "/code-review 66 high") to a
  // sidecar beside the transcript. Most of Claude's subagents are the
  // default "general-purpose" type, so this is what tells them apart.
  description?: string;
  startedAt: string;
  endedAt?: string;
  // last_assistant_message from the stop hook: the subagent's answer, capped.
  message?: string;
  // agent_transcript_path: its own conversation file, when the provider gives
  // one. Absent for a subagent still running (or closed out by a turn end).
  transcriptPath?: string;
}

type LedgerEvent =
  | { ev: "start"; id: string; type?: string; desc?: string; at: string }
  | { ev: "stop"; id: string; type?: string; desc?: string; at: string; msg?: string; transcript?: string }
  // A turn boundary closes the subagents still open, except the ones named in
  // `except` — forked/background subagents outlive the turn that spawned them
  // and report their own stop later.
  | { ev: "turn-end"; at: string; except?: string[] };

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
  sub: { id: string; type?: string; description?: string; at?: string },
): void {
  append(name, {
    ev: "start",
    id: sub.id,
    type: sub.type,
    desc: sub.description ? clipMessage(sub.description, 120) : undefined,
    at: sub.at ?? new Date().toISOString(),
  });
  compactIfLarge(name);
}

export function recordSubagentStop(
  name: string,
  sub: { id: string; type?: string; description?: string; message?: string; transcriptPath?: string; at?: string },
): void {
  append(name, {
    ev: "stop",
    id: sub.id,
    type: sub.type,
    desc: sub.description ? clipMessage(sub.description, 120) : undefined,
    at: sub.at ?? new Date().toISOString(),
    msg: sub.message ? clipMessage(sub.message) : undefined,
    transcript: sub.transcriptPath,
  });
  compactIfLarge(name);
}

// Called at a turn boundary (a turn starting, the agent going idle, the
// session ending). Cheap no-op when nothing is open, so it can run on every
// turn without growing the file. `keepOpen` spares subagents that legitimately
// outlive the turn.
export function closeOpenSubagents(
  name: string,
  opts: { at?: string; keepOpen?: (record: SubagentRecord) => boolean } = {},
): void {
  if (!existsSync(subagentsFile(name))) return;
  const open = readSubagents(name).filter((r) => !r.endedAt);
  if (open.length === 0) return;
  const except = opts.keepOpen ? open.filter(opts.keepOpen).map((r) => r.id) : [];
  if (except.length === open.length) return;
  append(name, { ev: "turn-end", at: opts.at ?? new Date().toISOString(), except: except.length ? except : undefined });
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
        if (!record.endedAt && !event.except?.includes(record.id)) record.endedAt = event.at;
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
      record.description = event.desc;
      record.endedAt = undefined;
      record.message = undefined;
      record.transcriptPath = undefined;
    } else {
      record.endedAt = event.at;
      // The sidecar lands after the start hook has fired, so the stop is
      // where the description usually reaches the ledger.
      if (event.desc && !record.description) record.description = event.desc;
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
    lines.push(JSON.stringify({ ev: "start", id: record.id, type: record.type, desc: record.description, at: record.startedAt }));
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

export interface RunningSubagent {
  id: string;
  type: string;
  description?: string;
  // A subagent's own subagent (Claude's sidecar names the parent): nested
  // under it rather than shown as a sibling of the agent's own fan-out.
  parentId?: string;
  startedAt: string;
}

// How a subagent is named to a person: what it was asked, else its type.
export function subagentLabel(sub: { type: string; description?: string }): string {
  return sub.description?.trim() || sub.type;
}

// Rows the sidebar nests under an agent, capped so a runaway fan-out can't
// swamp the list. Most recent last, like the ledger.
const RUNNING_ROWS = 8;

export interface SubagentSummary {
  active: number;
  // The types running, capped: "Explore, code-review +2".
  types: string;
  // Display-ready rollup for the status column: "2 subagents · Explore".
  detail: string;
  // The running subagents themselves, for the hub's nested rows. Travels in
  // `am ls --json`, so remote agents get rows in the same fetch — absent
  // from a remote whose am predates it, which then shows the rollup only.
  running?: RunningSubagent[];
}

// The types of what's running, most recent first, capped so a wide fan-out
// still fits a status column. Pure.
export function summarize(records: SubagentRecord[]): SubagentSummary | null {
  const open = records.filter((r) => !r.endedAt);
  if (open.length === 0) return null;
  const types: string[] = [];
  for (const record of [...open].reverse()) {
    const label = subagentLabel(record);
    if (!types.includes(label)) types.push(label);
  }
  const shown = types.slice(0, 2).join(", ") + (types.length > 2 ? ` +${types.length - 2}` : "");
  const noun = open.length === 1 ? "subagent" : "subagents";
  const running = open.slice(-RUNNING_ROWS).map(({ id, type, description, startedAt }) => ({ id, type, description, startedAt }));
  return { active: open.length, types: shown, detail: `${open.length} ${noun} · ${shown}`, running };
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

// Claude Code writes a sidecar next to each subagent transcript describing how
// it was launched. A forked ("background") subagent keeps running after the
// parent's turn ends, so a turn boundary must not close it. Anything we can't
// read is treated as foreground — the ledger should never hold a record open
// on a guess.
export function isBackgroundSubagent(agent: AgentState, subagentId: string): boolean {
  return readSubagentMeta(agent, subagentId)?.requestShape === "background";
}

interface SubagentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  requestShape?: string;
  parentAgentId?: string;
  spawnDepth?: number;
}

// The sidecar Claude writes beside a subagent's transcript at spawn. Codex has
// no such file, and locating its rollout can walk the whole ~/.codex/sessions
// tree — not something to do per record inside a hook.
export function readSubagentMeta(agent: AgentState, subagentId: string): SubagentMeta | null {
  if (agentProvider(agent) !== "claude") return null;
  const transcript = subagentTranscriptFile(agent, subagentId);
  return transcript ? readMetaBeside(transcript) : null;
}

function readMetaBeside(transcript: string): SubagentMeta | null {
  try {
    const meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return meta && typeof meta === "object" ? (meta as SubagentMeta) : null;
  } catch {
    return null;
  }
}

// What the subagent was asked, from its sidecar. The stop hook hands over the
// transcript path, which beats deriving it from the parent's.
export function subagentDescription(agent: AgentState, subagentId: string, transcriptPath?: string): string | undefined {
  if (agentProvider(agent) !== "claude") return undefined;
  const meta = transcriptPath ? readMetaBeside(transcriptPath) : readSubagentMeta(agent, subagentId);
  const description = meta?.description;
  return typeof description === "string" && description.trim() ? description : undefined;
}

// Fill in descriptions the start hook didn't catch from the live sidecar: it
// lands a beat after that hook fires, so the ledger learns the description
// only at the stop. Running ones only — a finished subagent's files are gone
// soon after, and its ledger row is all that remains.
export function describeRunning(agent: AgentState, summary: SubagentSummary | null): SubagentSummary | null {
  if (!summary?.running || agentProvider(agent) !== "claude") return summary;
  const running = summary.running.map((sub) => {
    const meta = readSubagentMeta(agent, sub.id);
    const description = sub.description ?? (typeof meta?.description === "string" && meta.description.trim() ? meta.description : undefined);
    const parentId = typeof meta?.parentAgentId === "string" && meta.parentAgentId ? meta.parentAgentId : undefined;
    return { ...sub, description, parentId };
  });
  const types: string[] = [];
  for (const sub of [...running].reverse()) {
    const label = subagentLabel(sub);
    if (!types.includes(label)) types.push(label);
  }
  const shown = types.slice(0, 2).join(", ") + (types.length > 2 ? ` +${types.length - 2}` : "");
  const noun = summary.active === 1 ? "subagent" : "subagents";
  return { ...summary, running, types: shown, detail: `${summary.active} ${noun} · ${shown}` };
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

const SCREEN_TAIL_BYTES = 256_000;

// A subagent's transcript as a screen: its own words and the tools it reached
// for, one line each, newest last. Tool output is left out — the parent's
// pane doesn't show it either, and it's most of the bytes. Pure.
export function renderSubagentScreen(turns: Turn[]): string[] {
  const lines: string[] = [];
  let briefed = false;
  for (const turn of turns) {
    if (turn.kind === "user") {
      // The first user turn is the brief whatever it starts with — a subagent
      // spawned on a skill body has nothing else to show for what it was asked.
      if (!briefed || !isHarnessNoise(turn.text)) lines.push(`❯ ${clipMessage(turn.text, 120)}`);
      briefed = true;
    } else if (turn.kind === "assistant") {
      lines.push(...turn.text.split("\n"));
    } else {
      lines.push(`⏺ ${describeToolCall(turn.name, turn.input)}`);
    }
  }
  return lines;
}

// User turns the harness injects — notifications, skill preambles, reminders —
// aren't the subagent's conversation, and a screen full of them hides what
// it was actually asked.
const HARNESS_NOISE = [
  "[SYSTEM NOTIFICATION",
  "[Request interrupted",
  "<system-reminder>",
  "<task-notification>",
  "Base directory for this skill",
];

export function isHarnessNoise(text: string): boolean {
  const head = text.trimStart();
  return HARNESS_NOISE.some((prefix) => head.startsWith(prefix));
}

// The one argument a reader wants for each tool, in priority order: the
// command, the path, the pattern, the question — never the JSON around it.
// `path` last: Grep and Glob carry it alongside the pattern that matters.
const SALIENT_ARGS = ["command", "file_path", "pattern", "query", "url", "skill", "description", "sql", "text", "prompt", "message", "function", "path"];
const ARG_CHARS = 100;

// A tool call the way the provider's own UI shows it: `Bash(git status)`,
// `Read(src/hook.ts)`, `playwright:browser_click(Undo change button)`.
// Falls back to the raw input when it isn't a JSON object.
export function describeToolCall(name: string, input: string): string {
  let args: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch {
    // free-form input (codex's shell command string, say)
  }
  const label = name.replace(/^mcp__(.+?)__(.+)$/, "$1:$2");
  if (!args) return `${label}(${clipMessage(input, ARG_CHARS)})`;
  const salient = SALIENT_ARGS.map((key) => argText(args![key])).find((v) => v !== null);
  const extra = label === "Skill" && typeof args.args === "string" && args.args.trim() ? ` ${args.args}` : "";
  if (salient) return `${label}(${clipMessage(salient + extra, ARG_CHARS)})`;
  const first = Object.values(args).map(argText).find((v) => v !== null);
  if (first) return `${label}(${clipMessage(first, ARG_CHARS)})`;
  return Object.keys(args).length === 0 ? `${label}()` : `${label}(${clipMessage(input, ARG_CHARS)})`;
}

// A non-blank string argument, or an argv-style list of strings joined into
// one (codex's `shell` passes `["bash","-lc","git status"]`). Null otherwise.
function argText(value: unknown): string | null {
  const text = Array.isArray(value) && value.every((v) => typeof v === "string") ? value.join(" ") : value;
  return typeof text === "string" && text.trim() ? text : null;
}

// The subagent's transcript as screen lines, or null when there is none to
// read yet. Its own file is preferred (the stop hook reports it); a running
// claude subagent's is derived from its id; codex reports nothing until stop.
export function subagentScreen(agent: AgentState, record: SubagentRecord): string[] | null {
  const own = record.transcriptPath && existsSync(record.transcriptPath) ? record.transcriptPath : null;
  const file = own ?? (agentProvider(agent) === "claude" ? subagentTranscriptFile(agent, record.id) : null);
  if (!file || !existsSync(file)) return null;
  const text = readFileTail(file, SCREEN_TAIL_BYTES);
  if (!text) return null;
  return renderSubagentScreen(parseTranscript(agentProvider(agent), text, { sidechain: { ownFile: true } }).turns);
}

// Why a subagent shows no output, in the provider's terms.
export function subagentNoOutputNote(agent: AgentState): string {
  return agentProvider(agent) === "codex"
    ? "no output yet — codex reports a subagent's transcript when it stops"
    : "no output yet — the subagent hasn't written a turn";
}

// The hook that would close a record can go missing — a background subagent
// killed with an interrupted turn, a session that died and was resumed — and
// a spared background record then reads as running forever. Claude leaves a
// second trail: when a background subagent ends, the parent's transcript
// receives a task notification naming it. Scan what each transcript has added
// since the last look and close every open record it reports. Claude only;
// returns how many records it closed.
const NOTIFICATION_TAIL_BYTES = 1_000_000;
const scanned = new Map<string, number>(); // transcript path → bytes already scanned, at a line boundary

export function reconcileOpenSubagents(agent: AgentState): number {
  if (agentProvider(agent) !== "claude") return 0;
  const open = readSubagents(agent.name).filter((r) => !r.endedAt);
  if (open.length === 0) return 0;
  const added = new Map<string, string[]>();
  const linesOf = (file: string): string[] => {
    let lines = added.get(file);
    if (!lines) added.set(file, (lines = newLines(file)));
    return lines;
  };
  let closed = 0;
  for (const record of open) {
    const file = notificationFile(agent, record.id);
    const ended = (file && completionAfter(linesOf(file), record.id, record.startedAt)) || diedMidTurn(agent, record.id);
    if (!ended) continue;
    recordSubagentStop(agent.name, { id: record.id, type: record.type, message: ended.summary });
    closed++;
  }
  return closed;
}

// Where a subagent's notification lands: its parent's transcript — for a
// subagent's own subagent, the parent subagent's file, not the agent's.
function notificationFile(agent: AgentState, id: string): string | null {
  const parentId = readSubagentMeta(agent, id)?.parentAgentId;
  if (typeof parentId === "string" && parentId) return subagentTranscriptFile(agent, parentId);
  try {
    return locateTranscript(agent);
  } catch {
    return null;
  }
}

// The complete lines a transcript gained since the last look (the last 1MB
// on the first). A line still being written is left for the next look, so a
// notification flushed in two parts is never skipped over.
function newLines(file: string): string[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  let from = scanned.get(file) ?? Math.max(0, size - NOTIFICATION_TAIL_BYTES);
  if (from > size) from = Math.max(0, size - NOTIFICATION_TAIL_BYTES); // replaced or truncated
  if (size <= from) return [];
  const buf = readRange(file, from, size);
  const end = buf.lastIndexOf(0x0a);
  if (end === -1) return [];
  scanned.set(file, from + end + 1);
  return buf.subarray(0, end).toString("utf8").split("\n");
}

// Only a notification written after the record started counts: a background
// subagent resumes under the same id, and every earlier run's notification
// stays in the transcript. A line with no timestamp (cut by the window) is
// ignored rather than trusted. Pure.
export function completionAfter(lines: string[], id: string, startedAt: string): { status: string; summary?: string } | null {
  const tag = `<task-id>${id}</task-id>`;
  const since = Date.parse(startedAt);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(tag)) continue;
    const at = entryTimestamp(line);
    if (at === null || at <= since) continue;
    const ended = completionIn(line, id);
    if (ended) return ended;
  }
  return null;
}

function entryTimestamp(line: string): number | null {
  try {
    const stamp = JSON.parse(line)?.timestamp;
    return typeof stamp === "string" ? Date.parse(stamp) : null;
  } catch {
    return null;
  }
}

// A subagent killed with its parent's turn (an interrupt, a restart) writes
// no notification and fires no hook. Its own transcript tells: the model
// answers a tool result within seconds, so a transcript that ends on one and
// hasn't been touched in minutes is a subagent nobody is running. A tool
// call still in flight (a long sleep, a watch) ends on the assistant's turn
// instead and stays open.
const DEAD_AFTER_MS = 5 * 60 * 1000;

function diedMidTurn(agent: AgentState, id: string, now = Date.now()): { status: string; summary: string } | null {
  const file = subagentTranscriptFile(agent, id);
  if (!file) return null;
  let mtime: number;
  let size: number;
  try {
    ({ mtimeMs: mtime, size } = statSync(file));
  } catch {
    return null;
  }
  if (now - mtime < DEAD_AFTER_MS) return null;
  const last = lastEntryType(readRange(file, Math.max(0, size - 64_000), size).toString("utf8"));
  if (last !== "user") return null;
  return { status: "stopped", summary: "stopped mid-turn — no reply to its last tool result" };
}

// The type of the last complete JSON line. Pure.
export function lastEntryType(jsonlTail: string): string | null {
  const lines = jsonlTail.split("\n").filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!);
      if (typeof entry?.type === "string") return entry.type;
    } catch {
      // a torn last line, or the first line cut by the tail window
    }
  }
  return null;
}

function readRange(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf;
  } finally {
    closeSync(fd);
  }
}

// The notification as it sits in the transcript's JSON: tags with escaped
// newlines between them. Pure.
export function completionIn(text: string, id: string): { status: string; summary?: string } | null {
  const at = text.indexOf(`<task-id>${id}</task-id>`);
  if (at === -1) return null;
  const rest = text.slice(at, at + 2000);
  const status = /<status>(\w+)<\/status>/.exec(rest);
  if (!status || status[1] === "running") return null;
  const summary = /<summary>([^<]*)<\/summary>/.exec(rest);
  return { status: status[1]!, summary: unescapeJson(summary?.[1] ?? "").trim() || undefined };
}

// The text was cut out of a JSON string, so quotes and newlines arrive as
// their escapes. Decode them the way JSON would; leave it as-is if it isn't
// a well-formed fragment.
function unescapeJson(fragment: string): string {
  try {
    return JSON.parse(`"${fragment}"`) as string;
  } catch {
    return fragment;
  }
}
