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

// Subagent turns live in the parent's session file, tagged isSidechain and
// carrying the agent id the SubagentStart/Stop hooks report.
const SIDECHAIN_JSONL = [
  JSON.stringify({
    type: "assistant",
    sessionId: "s-1",
    message: { role: "assistant", content: [{ type: "text", text: "main chain" }] },
  }),
  JSON.stringify({
    type: "user",
    isSidechain: true,
    agentId: "sub-a",
    message: { role: "user", content: "find the hook handlers" },
  }),
  JSON.stringify({
    type: "assistant",
    isSidechain: true,
    agentId: "sub-a",
    message: { role: "assistant", content: [{ type: "text", text: "they're in hook.ts" }] },
  }),
  JSON.stringify({
    type: "assistant",
    isSidechain: true,
    agentId: "sub-b",
    message: { role: "assistant", content: [{ type: "text", text: "other subagent" }] },
  }),
].join("\n");

describe("parseClaudeTranscript — subagent side-chains", () => {
  test("renders only the requested subagent's turns", () => {
    const sub = parseClaudeTranscript(SIDECHAIN_JSONL, { sidechain: { agentId: "sub-a" } });
    expect(sub.turns.map((t) => (t as any).text)).toEqual(["find the hook handlers", "they're in hook.ts"]);
  });

  test("the main chain still excludes every subagent", () => {
    const main = parseClaudeTranscript(SIDECHAIN_JSONL);
    expect(main.turns.map((t) => (t as any).text)).toEqual(["main chain"]);
  });

  test("a dedicated subagent transcript renders whole, brief included", () => {
    const own = [
      // The brief a subagent is handed is written as an isMeta entry, which
      // is harness noise in the main chain but the opening turn here.
      JSON.stringify({ type: "user", isMeta: true, isSidechain: true, message: { role: "user", content: "go" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const sub = parseClaudeTranscript(own, { sidechain: { agentId: "sub-a", ownFile: true } });
    expect(sub.turns.map((t) => (t as any).text)).toEqual(["go", "done"]);
  });

  test("a parent file with no side-chain yet renders nothing, never the parent's chat", () => {
    // A subagent that has just started has flushed no turns — rendering the
    // whole parent conversation under its name would leak the wrong chat.
    const parentOnly = [
      JSON.stringify({ type: "user", message: { role: "user", content: "secret parent prompt" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "parent reply" }] } }),
    ].join("\n");
    expect(parseClaudeTranscript(parentOnly, { sidechain: { agentId: "sub-a" } }).turns).toEqual([]);
  });

  test("an unknown id in a file that has ids renders nothing, not the parent's chat", () => {
    const sub = parseClaudeTranscript(SIDECHAIN_JSONL, { sidechain: { agentId: "sub-zzz" } });
    expect(sub.turns).toEqual([]);
  });

  test("untagged side-chains render nothing rather than every subagent at once", () => {
    // An older transcript marks isSidechain but carries no agentId, so two
    // parallel subagents are indistinguishable — merging them under one
    // label would be worse than an empty result the caller can explain.
    const untagged = [
      JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "one" }] } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "two" }] } }),
    ].join("\n");
    expect(parseClaudeTranscript(untagged, { sidechain: { agentId: "sub-a" } }).turns).toEqual([]);
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

  test("a local_shell_call pairs with its output by call_id too", () => {
    const jsonl = [
      JSON.stringify({
        type: "response_item",
        payload: { type: "local_shell_call", call_id: "s1", action: { type: "exec", command: ["ls"] } },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "s1", output: "a.ts\nb.ts" } }),
    ].join("\n");
    const tool = parseCodexTranscript(jsonl).turns[0] as any;
    expect(tool.name).toBe("shell");
    expect(tool.output).toBe("a.ts\nb.ts");
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
