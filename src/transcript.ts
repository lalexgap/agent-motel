import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentProvider, agentSessionId, type AgentState, type Provider } from "./state";
import { codexHome } from "./codexHooks";

// Canonical cross-provider conversation model. Both native stores are
// append-only JSONL and remain the source of truth — this is rendered on
// demand (for `am transcript` / `am handoff`), never synced.
export type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: string; output?: string };

export interface Transcript {
  source: Provider;
  sessionId?: string;
  dir?: string;
  startedAt?: string;
  turns: Turn[];
}

function parseLines(jsonl: string): Record<string, any>[] {
  const entries: Record<string, any>[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A live session can be mid-write on its last line.
    }
  }
  return entries;
}

// Claude Code stores sessions as ~/.claude/projects/<cwd-slug>/<uuid>.jsonl.
export function claudeProjectSlug(dir: string): string {
  return dir.replaceAll(/[^a-zA-Z0-9]/g, "-");
}

const CLAUDE_HARNESS_PREFIXES = ["<command-name>", "<local-command-stdout>", "<system-reminder>"];

export function parseClaudeTranscript(jsonl: string): Transcript {
  const transcript: Transcript = { source: "claude", turns: [] };
  const toolsById = new Map<string, Extract<Turn, { kind: "tool" }>>();

  for (const entry of parseLines(jsonl)) {
    if (entry.isSidechain || entry.isMeta) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    transcript.sessionId ??= entry.sessionId;
    transcript.dir ??= entry.cwd;
    transcript.startedAt ??= entry.timestamp;

    const content = entry.message?.content;
    if (entry.type === "user") {
      if (typeof content === "string") {
        if (content.trim() && !CLAUDE_HARNESS_PREFIXES.some((p) => content.startsWith(p))) {
          transcript.turns.push({ kind: "user", text: content });
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          if (!CLAUDE_HARNESS_PREFIXES.some((p) => block.text.startsWith(p))) {
            transcript.turns.push({ kind: "user", text: block.text });
          }
        } else if (block.type === "tool_result") {
          const tool = toolsById.get(block.tool_use_id);
          if (tool) tool.output = flattenToolResult(block.content);
        }
      }
    } else {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          transcript.turns.push({ kind: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          const tool: Extract<Turn, { kind: "tool" }> = {
            kind: "tool",
            name: block.name ?? "tool",
            input: compactValue(block.input),
          };
          toolsById.set(block.id, tool);
          transcript.turns.push(tool);
        }
      }
    }
  }
  return transcript;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function compactValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Codex wraps harness context in pseudo-tags inside user messages.
const CODEX_HARNESS_PREFIXES = ["<user_instructions>", "<environment_context>", "<turn_context>", "<permissions"];

export function parseCodexTranscript(jsonl: string): Transcript {
  const transcript: Transcript = { source: "codex", turns: [] };
  const toolsByCallId = new Map<string, Extract<Turn, { kind: "tool" }>>();

  for (const entry of parseLines(jsonl)) {
    const payload = entry.payload;
    if (entry.type === "session_meta" && payload) {
      transcript.sessionId = payload.id;
      transcript.dir = payload.cwd;
      transcript.startedAt = payload.timestamp;
      continue;
    }
    if (entry.type !== "response_item" || !payload) continue;

    if (payload.type === "message") {
      const text = Array.isArray(payload.content)
        ? payload.content
            .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
            .filter(Boolean)
            .join("\n")
        : "";
      if (!text.trim()) continue;
      if (payload.role === "user") {
        if (CODEX_HARNESS_PREFIXES.some((p) => text.startsWith(p))) continue;
        transcript.turns.push({ kind: "user", text });
      } else if (payload.role === "assistant") {
        transcript.turns.push({ kind: "assistant", text });
      }
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const tool: Extract<Turn, { kind: "tool" }> = {
        kind: "tool",
        name: payload.name ?? "tool",
        input: compactValue(payload.arguments ?? payload.input),
      };
      if (payload.call_id) toolsByCallId.set(payload.call_id, tool);
      transcript.turns.push(tool);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const tool = toolsByCallId.get(payload.call_id);
      if (tool) tool.output = extractCodexOutput(payload.output);
    } else if (payload.type === "local_shell_call") {
      transcript.turns.push({
        kind: "tool",
        name: "shell",
        input: compactValue(payload.action?.command ?? payload.action),
      });
    }
  }
  return transcript;
}

// function_call_output.output is either plain text or a JSON envelope like
// {"output": "...", "metadata": {...}}.
function extractCodexOutput(output: unknown): string {
  if (typeof output !== "string") return compactValue(output);
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed?.output === "string") return parsed.output;
  } catch {
    // plain text
  }
  return output;
}

export function parseTranscript(provider: Provider, jsonl: string): Transcript {
  return provider === "codex" ? parseCodexTranscript(jsonl) : parseClaudeTranscript(jsonl);
}

// A single conversation line's searchable text, role-labeled. `am search` runs
// ripgrep over the raw JSONL (fast at any size), then feeds each matched line
// here to recover clean snippet text — applying the SAME noise/harness rules as
// the full parsers above, so a hit inside a uuid, a tool envelope, or a harness
// banner yields no fragment and is dropped. Returns [] for structural/meta lines.
export interface Fragment {
  kind: "user" | "assistant" | "tool";
  text: string;
}

export function entryFragments(provider: Provider, entry: Record<string, any>): Fragment[] {
  return provider === "codex" ? codexEntryFragments(entry) : claudeEntryFragments(entry);
}

function claudeEntryFragments(entry: Record<string, any>): Fragment[] {
  if (entry.isSidechain || entry.isMeta) return [];
  if (entry.type !== "user" && entry.type !== "assistant") return [];
  const out: Fragment[] = [];
  const content = entry.message?.content;
  if (entry.type === "user") {
    if (typeof content === "string") {
      if (content.trim() && !CLAUDE_HARNESS_PREFIXES.some((p) => content.startsWith(p))) {
        out.push({ kind: "user", text: content });
      }
      return out;
    }
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        if (!CLAUDE_HARNESS_PREFIXES.some((p) => block.text.startsWith(p))) {
          out.push({ kind: "user", text: block.text });
        }
      } else if (block.type === "tool_result") {
        const text = flattenToolResult(block.content);
        if (text.trim()) out.push({ kind: "tool", text });
      }
    }
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block.type === "text" && block.text?.trim()) {
      out.push({ kind: "assistant", text: block.text });
    } else if (block.type === "tool_use") {
      const input = compactValue(block.input);
      if (input.trim()) out.push({ kind: "tool", text: `${block.name ?? "tool"} ${input}` });
    }
  }
  return out;
}

function codexEntryFragments(entry: Record<string, any>): Fragment[] {
  const payload = entry.payload;
  if (entry.type !== "response_item" || !payload) return [];
  const out: Fragment[] = [];
  if (payload.type === "message") {
    const text = Array.isArray(payload.content)
      ? payload.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n")
      : "";
    if (!text.trim()) return out;
    if (payload.role === "user") {
      if (CODEX_HARNESS_PREFIXES.some((p) => text.startsWith(p))) return out;
      out.push({ kind: "user", text });
    } else if (payload.role === "assistant") {
      out.push({ kind: "assistant", text });
    }
  } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const input = compactValue(payload.arguments ?? payload.input);
    if (input.trim()) out.push({ kind: "tool", text: `${payload.name ?? "tool"} ${input}` });
  } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const text = extractCodexOutput(payload.output);
    if (text.trim()) out.push({ kind: "tool", text });
  } else if (payload.type === "local_shell_call") {
    const input = compactValue(payload.action?.command ?? payload.action);
    if (input.trim()) out.push({ kind: "tool", text: `shell ${input}` });
  }
  return out;
}

// Find the agent's native session file. Hook payloads from both providers
// include transcript_path, so the captured path is authoritative; the
// fallbacks reconstruct it from the session id.
export function locateTranscript(agent: AgentState): string {
  if (agent.transcriptPath && existsSync(agent.transcriptPath)) return agent.transcriptPath;

  const sessionId = agentSessionId(agent);
  if (!sessionId) {
    throw new Error(
      `agent "${agent.name}" has no recorded session id yet — it needs at least one turn (or one hook event) first`,
    );
  }
  if (agentProvider(agent) === "codex") {
    const file = findCodexRollout(join(codexHome(), "sessions"), sessionId);
    if (file) return file;
    throw new Error(`no codex rollout found for session ${sessionId} under ${codexHome()}/sessions`);
  }
  // Claude keys its transcript by the realpath of the cwd (symlinks resolved),
  // while am stores the LOGICAL dir so it stays portable across machines.
  // Resolve here so the slug matches what claude actually wrote; fall back to
  // the stored path if the dir isn't present on this machine.
  const file = join(homedir(), ".claude", "projects", claudeProjectSlugResolved(agent.dir), `${sessionId}.jsonl`);
  if (existsSync(file)) return file;
  throw new Error(`no claude session file at ${file}`);
}

// Slug for claude's transcript directory. Claude keys the project by the
// realpath of the cwd (symlinks resolved), while am stores the LOGICAL dir so
// the record stays portable across machines — so resolve here. Falls back to
// the stored path when the dir isn't present on this machine.
export function claudeProjectSlugResolved(dir: string): string {
  let resolved = dir;
  try {
    resolved = realpathSync(dir);
  } catch {
    // dir absent on this machine — best-effort with the logical path
  }
  return claudeProjectSlug(resolved);
}

// Rollouts live at sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl.
function findCodexRollout(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (name.endsWith(`${sessionId}.jsonl`)) return path;
    }
  }
  return null;
}

const COMPACT_INPUT_CHARS = 200;
const COMPACT_OUTPUT_CHARS = 500;
const COMPACT_OUTPUT_LINES = 6;

function truncate(text: string, chars: number, lines?: number): string {
  let result = text;
  if (lines !== undefined) {
    const split = result.split("\n");
    if (split.length > lines) result = split.slice(0, lines).join("\n");
  }
  if (result.length > chars) result = result.slice(0, chars);
  if (result.length < text.length) {
    result += ` … [+${text.length - result.length} chars]`;
  }
  return result;
}

// A turn sized for transport (the phone API): tool input/output cut to the
// same compact limits the markdown renderer uses. User/assistant text is kept
// whole — the app needs it for display and speech.
export function compactTurn(turn: Turn): Turn {
  if (turn.kind !== "tool") return turn;
  const compact: Extract<Turn, { kind: "tool" }> = {
    kind: "tool",
    name: turn.name,
    input: truncate(turn.input.replaceAll("\n", " "), COMPACT_INPUT_CHARS),
  };
  if (turn.output?.trim()) {
    compact.output = truncate(turn.output, COMPACT_OUTPUT_CHARS, COMPACT_OUTPUT_LINES);
  }
  return compact;
}

export function renderTranscript(
  transcript: Transcript,
  opts: { full?: boolean; agentName?: string } = {},
): string {
  const lines: string[] = ["---"];
  lines.push(`source: ${transcript.source}`);
  if (opts.agentName) lines.push(`agent: ${opts.agentName}`);
  if (transcript.sessionId) lines.push(`session_id: ${transcript.sessionId}`);
  if (transcript.dir) lines.push(`dir: ${transcript.dir}`);
  if (transcript.startedAt) lines.push(`started: ${transcript.startedAt}`);
  lines.push(`exported: ${new Date().toISOString()}`, `mode: ${opts.full ? "full" : "compact"}`, "---", "");

  for (const turn of transcript.turns) {
    if (turn.kind === "user") {
      lines.push("## User", "", turn.text, "");
    } else if (turn.kind === "assistant") {
      lines.push("## Assistant", "", turn.text, "");
    } else {
      const input = opts.full ? turn.input : truncate(turn.input.replaceAll("\n", " "), COMPACT_INPUT_CHARS);
      lines.push(`> 🔧 ${turn.name}: \`${input}\``);
      if (turn.output?.trim()) {
        const output = opts.full
          ? turn.output
          : truncate(turn.output, COMPACT_OUTPUT_CHARS, COMPACT_OUTPUT_LINES);
        lines.push(">", ...output.split("\n").map((l) => `> ${l}`));
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
