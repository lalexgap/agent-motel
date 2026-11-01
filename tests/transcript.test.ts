import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptJson } from "../src/commands/transcript";
import { sourceTranscript } from "../src/commands/move";
import {
  locateTranscript,
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
      content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 fail" }], is_error: true }],
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
    expect(tool.error).toBe(true);
  });

  test("keeps prompts typed mid-turn, which Claude logs as queued_command attachments", () => {
    const queued = (prompt: string, extra = {}) => JSON.stringify({ type: "attachment", isSidechain: false, sessionId: "s-1",
      attachment: { type: "queued_command", prompt, commandMode: "prompt", ...extra } });
    const parsed = parseClaudeTranscript([CLAUDE_JSONL, queued("also fix the header"), queued("/compact", { commandMode: "bash" }),
      queued("sidechain", {}).replace('"isSidechain":false', '"isSidechain":true')].join("\n"));
    const users = parsed.turns.filter((t) => t.kind === "user").map((t: any) => t.text);
    expect(users.at(-1)).toBe("also fix the header");
    expect(users).not.toContain("/compact");
    expect(users).not.toContain("sidechain");
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
      JSON.stringify({ type: "response_item", payload: { type: "local_shell_call_output", call_id: "s1", output: "a.ts\nb.ts" } }),
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


describe("locateTranscript stale provider metadata", () => {
  test("ignores null and non-object records for discovery and move/export", () => {
    const root = mkdtempSync(join(tmpdir(), "am-transcript-null-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      mkdirSync(join(root, "sessions"));
      const claude = join(root, "claude.jsonl");
      const codex = join(root, "sessions", "rollout-c-1.jsonl");
      const prefix = 'null\n42\n"text"\ntrue\n[]\n';
      writeFileSync(claude, prefix + CLAUDE_JSONL);
      writeFileSync(codex, prefix + CODEX_JSONL);
      const agent = { name: "concierge", provider: "codex" as const, status: "idle" as const,
        dir: root, tmuxSession: "test", createdAt: "now", updatedAt: "now",
        sessionId: "c-1", transcriptPath: codex };
      expect(locateTranscript(agent)).toBe(codex);
      expect(sourceTranscript(agent)).toEqual({ path: codex, codexRelative: "sessions/rollout-c-1.jsonl" });
      expect(locateTranscript({ ...agent, transcriptPath: claude })).toBe(codex);
      expect(sourceTranscript({ ...agent, provider: "claude", transcriptPath: claude }))
        .toEqual({ path: claude, codexRelative: null });
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores a Claude path for Codex and falls back without mutating state", () => {
    const root = mkdtempSync(join(tmpdir(), "am-transcript-provider-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      mkdirSync(join(root, "sessions"));
      const wrong = join(root, "old-claude.jsonl");
      const rollout = join(root, "sessions", "rollout-c-1.jsonl");
      writeFileSync(wrong, CLAUDE_JSONL);
      writeFileSync(rollout, CODEX_JSONL);
      const agent = { name: "concierge", provider: "codex" as const, status: "idle" as const,
        dir: root, tmuxSession: "test", createdAt: "now", updatedAt: "now",
        sessionId: "c-1", transcriptPath: wrong };
      expect(locateTranscript(agent)).toBe(rollout);
      expect(parseCodexTranscript(readFileSync(locateTranscript(agent), "utf8")).turns.length).toBeGreaterThan(0);
      expect(agent.transcriptPath).toBe(wrong);
      expect(locateTranscript({ ...agent, transcriptPath: rollout })).toBe(rollout);
      expect(() => locateTranscript({ ...agent, sessionId: "old-claude-id" })).toThrow("no codex rollout found");
      expect(locateTranscript({ ...agent, provider: "claude" })).toBe(wrong);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("Codex parent transcript identity", () => {
  test("recovers full parent history when a child hook leaves another Codex path", () => {
    const root = mkdtempSync(join(tmpdir(), "am-transcript-identity-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      mkdirSync(join(root, "sessions"));
      const parent = join(root, "sessions", "rollout-parent.jsonl");
      const child = join(root, "child.jsonl");
      const meta = (id: string) => JSON.stringify({ type: "session_meta", payload: { id } });
      const message = (text: string) => JSON.stringify({ type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text }],
      } });
      const history = Array.from({ length: 30 }, (_, index) => message(`Parent reply ${index}`));
      writeFileSync(parent, [meta("parent"), ...history].join("\n"));
      // Keep session_meta outside the old 64 KiB tail used for provider checks.
      writeFileSync(child, [meta("child"), message("Child report"), JSON.stringify({ type: "event_msg", padding: "x".repeat(150000) })].join("\n"));
      const agent = { name: "newsletter", provider: "codex" as const, status: "idle" as const,
        dir: root, tmuxSession: "test", createdAt: "now", updatedAt: "now",
        sessionId: "parent", transcriptPath: child };
      expect(locateTranscript(agent)).toBe(parent);
      expect(transcriptJson(agent).entries.map(entry => entry.kind === "assistant" ? entry.text : "")).toEqual(
        Array.from({ length: 30 }, (_, index) => `Parent reply ${index}`));
      writeFileSync(parent, [meta("parent"), ...history, message("New parent reply")].join("\n"));
      expect(transcriptJson(agent).total).toBe(31);
      expect(agent.transcriptPath).toBe(child);
      expect(agent.sessionId).toBe("parent");
      expect(locateTranscript({ ...agent, transcriptPath: parent })).toBe(parent);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a named child rollout even when its metadata header exceeds the probe", () => {
    const root = mkdtempSync(join(tmpdir(), "am-transcript-large-meta-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      mkdirSync(join(root, "sessions"));
      const parentId = "00000000-0000-0000-0000-000000000001";
      const childId = "00000000-0000-0000-0000-000000000002";
      const parent = join(root, "sessions", `rollout-date-${parentId}.jsonl`);
      const child = join(root, "sessions", `rollout-date-${childId}.jsonl`);
      writeFileSync(parent, JSON.stringify({ type: "session_meta", payload: { id: parentId } }) + "\n");
      writeFileSync(child, JSON.stringify({ type: "session_meta", payload: { id: childId, instructions: "x".repeat(200000) } }) + "\n");
      const agent = { name: "newsletter", provider: "codex" as const, status: "idle" as const,
        dir: root, tmuxSession: "test", createdAt: "now", updatedAt: "now",
        sessionId: parentId, transcriptPath: child };
      expect(locateTranscript(agent)).toBe(parent);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
