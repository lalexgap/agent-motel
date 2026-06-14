import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectSlug,
  claudeProjectSlugResolved,
  parseClaudeTranscript,
  parseCodexTranscript,
  renderTranscript,
} from "../src/transcript";

describe("claudeProjectSlugResolved", () => {
  test("resolves a symlinked dir to its real target's slug (matches what claude wrote)", () => {
    const root = mkdtempSync(join(tmpdir(), "am-slug-"));
    const real = join(root, "real-checkout");
    mkdirSync(real);
    const link = join(root, "link-checkout");
    symlinkSync(real, link);
    // A logical (symlink) dir and its real target must produce the SAME slug,
    // since claude keys the transcript by the resolved path.
    expect(claudeProjectSlugResolved(link)).toBe(claudeProjectSlug(real));
    expect(claudeProjectSlugResolved(link)).not.toBe(claudeProjectSlug(link));
  });

  test("falls back to the logical path when the dir is absent on this machine", () => {
    const missing = "/mnt/nonexistent-on-this-host/code/x";
    expect(claudeProjectSlugResolved(missing)).toBe(claudeProjectSlug(missing));
  });
});

// Shapes mirror real session files (see ~/.claude/projects/*/<id>.jsonl and
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
const CLAUDE_JSONL = [
  JSON.stringify({ type: "mode", mode: "normal", sessionId: "s-1" }),
  JSON.stringify({
    type: "user",
    sessionId: "s-1",
    cwd: "/Users/x/proj",
    timestamp: "2026-06-01T00:00:00Z",
    message: { role: "user", content: "fix the tests" },
  }),
  JSON.stringify({
    type: "assistant",
    sessionId: "s-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Looking now." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    sessionId: "s-1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 fail" }] }],
    },
  }),
  JSON.stringify({
    type: "user",
    isSidechain: true,
    message: { role: "user", content: "subagent noise" },
  }),
  JSON.stringify({
    type: "assistant",
    sessionId: "s-1",
    message: { role: "assistant", content: [{ type: "text", text: "Fixed them." }] },
  }),
].join("\n");

describe("parseClaudeTranscript", () => {
  const transcript = parseClaudeTranscript(CLAUDE_JSONL);

  test("captures metadata and conversational turns, skipping sidechains", () => {
    expect(transcript.sessionId).toBe("s-1");
    expect(transcript.dir).toBe("/Users/x/proj");
    expect(transcript.turns.map((t) => t.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  test("pairs tool results back to their tool_use by id", () => {
    const tool = transcript.turns.find((t) => t.kind === "tool") as any;
    expect(tool.name).toBe("Bash");
    expect(tool.input).toContain("bun test");
    expect(tool.output).toBe("3 fail");
  });

  test("survives a half-written trailing line", () => {
    const partial = parseClaudeTranscript(CLAUDE_JSONL + '\n{"type":"assist');
    expect(partial.turns.length).toBe(transcript.turns.length);
  });
});

const CODEX_JSONL = [
  JSON.stringify({
    type: "session_meta",
    payload: { id: "c-1", cwd: "/Users/x/proj", timestamp: "2026-06-01T00:00:00Z" },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>...</user_instructions>" }] },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the tests" }] },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name: "shell", call_id: "f1", arguments: '{"command":["bun","test"]}' },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "f1", output: '{"output":"3 fail","metadata":{}}' },
  }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed them." }] },
  }),
].join("\n");

describe("parseCodexTranscript", () => {
  const transcript = parseCodexTranscript(CODEX_JSONL);

  test("captures session_meta and filters harness-wrapped user messages", () => {
    expect(transcript.sessionId).toBe("c-1");
    expect(transcript.dir).toBe("/Users/x/proj");
    expect(transcript.turns.map((t) => t.kind)).toEqual(["user", "tool", "assistant"]);
    expect((transcript.turns[0] as any).text).toBe("fix the tests");
  });

  test("unwraps the function_call_output JSON envelope", () => {
    const tool = transcript.turns.find((t) => t.kind === "tool") as any;
    expect(tool.output).toBe("3 fail");
  });
});

describe("renderTranscript", () => {
  test("compact mode truncates tool output, full mode keeps it", () => {
    const transcript = parseCodexTranscript(CODEX_JSONL);
    (transcript.turns[1] as any).output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const compact = renderTranscript(transcript);
    const full = renderTranscript(transcript, { full: true });
    expect(compact).toContain("[+");
    expect(compact).not.toContain("line 29");
    expect(full).toContain("line 29");
  });

  test("frontmatter carries source, session and dir", () => {
    const markdown = renderTranscript(parseClaudeTranscript(CLAUDE_JSONL), { agentName: "api" });
    expect(markdown).toContain("source: claude");
    expect(markdown).toContain("agent: api");
    expect(markdown).toContain("session_id: s-1");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("## Assistant");
  });
});

describe("claudeProjectSlug", () => {
  test("matches Claude Code's project directory naming", () => {
    expect(claudeProjectSlug("/Users/lagap")).toBe("-Users-lagap");
    expect(claudeProjectSlug("/Users/x/my.app")).toBe("-Users-x-my-app");
  });
});
