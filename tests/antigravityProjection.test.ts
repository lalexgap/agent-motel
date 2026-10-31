import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { antigravityTranscriptPath } from "../src/antigravity";
import { transcriptJson } from "../src/commands/transcript";
import { entryFragments, locateTranscript, parseTranscript } from "../src/transcript";

const provenance = {
  createdAt: "2026-10-31T20:00:00Z", sessionId: "conversation-1",
  timestamp: "2026-10-31T20:01:00Z", dir: "/fixture/project",
};
const record = (kind: string, fields: Record<string, unknown> = {}) => ({ ...provenance, kind, ...fields });
const jsonl = (records: unknown[]) => records.map(value => JSON.stringify(value)).join("\n");
const project = (records: unknown[]) => parseTranscript("antigravity", jsonl(records));
const delta = (responseId: unknown, text: unknown) => record("assistant_delta", { responseId, text });
const final = (responseId: unknown, text: unknown) => record("assistant_final", { responseId, text });
const tool = (fields: Record<string, unknown> = {}) => record("tool", {
  activityId: "activity-1", name: "tool", input: "Tool activity in progress", ...fields,
});

describe("Antigravity append-only transcript projection", () => {
  test("shows partial text before final and tolerates an incomplete trailing write", () => {
    const records = [record("user", { text: "task" }), delta("response-1", "Working"), delta("response-1", " now.")];
    const parsed = parseTranscript("antigravity", jsonl(records) + '\n{"kind":"assistant_final"');
    expect(parsed.turns).toEqual([{ kind: "user", text: "task" }, { kind: "assistant", text: "Working now." }]);
    expect(parsed).toMatchObject({ source: "antigravity", sessionId: provenance.sessionId, dir: provenance.dir, startedAt: provenance.timestamp });
  });

  test("updates assistant and tool contents without shifting their first-appearance indices", () => {
    const records = [record("user", { text: "task" }), delta("response-1", "Checking"), tool(),
      delta("response-1", " files"), record("user", { text: "also this" })];
    expect(project(records).turns.map((turn, index) => [index, turn.kind])).toEqual([
      [0, "user"], [1, "assistant"], [2, "tool"], [3, "user"],
    ]);
    records.push(tool({ output: "Tool activity completed", error: false }), final("response-1", "Canonical answer"));
    expect(project(records).turns).toEqual([
      { kind: "user", text: "task" }, { kind: "assistant", text: "Canonical answer" },
      { kind: "tool", name: "tool", input: "Tool activity in progress", output: "Tool activity completed", error: false },
      { kind: "user", text: "also this" },
    ]);
  });

  test("keeps response IDs and tool activity IDs independent across turns", () => {
    expect(project([
      delta("response-1", "First"), tool({ activityId: "response-1" }),
      record("user", { text: "next" }), delta("response-2", "Second"),
      delta("response-1", " partial"), final("response-2", "Second final"), final("response-1", "First final"),
      tool({ activityId: "activity-2", output: "Tool activity failed", error: true }),
    ]).turns).toEqual([
      { kind: "assistant", text: "First final" }, { kind: "tool", name: "tool", input: "Tool activity in progress" },
      { kind: "user", text: "next" }, { kind: "assistant", text: "Second final" },
      { kind: "tool", name: "tool", input: "Tool activity in progress", output: "Tool activity failed", error: true },
    ]);
  });

  test("canonical final replaces all partial text, never appends or duplicates", () => {
    expect(project([delta("r", "draft"), delta("r", " draft"), final("r", "Rewritten answer"),
      final("r", "Rewritten answer"), delta("r", "late chunk")]).turns)
      .toEqual([{ kind: "assistant", text: "Rewritten answer" }]);
    expect(project([final("r", "No stream"), final("r", "Revised final")]).turns)
      .toEqual([{ kind: "assistant", text: "Revised final" }]);
    expect(project([delta("r", "discarded"), final("r", "")]).turns)
      .toEqual([{ kind: "assistant", text: "" }]);
  });

  test("keeps tool completion while merging subsequent progress and explicit error changes", () => {
    expect(project([tool({ output: "Tool activity failed", error: true }), tool(),
      tool({ output: "Tool activity completed", error: false })]).turns).toEqual([
      { kind: "tool", name: "tool", input: "Tool activity in progress", output: "Tool activity completed", error: false },
    ]);
  });

  test("preserves legacy AM records exactly, including repeated and empty text", () => {
    const turns: ReturnType<typeof parseTranscript>["turns"] = [{ kind: "user", text: "  task\n" }, { kind: "assistant", text: "same" },
      { kind: "assistant", text: "same" }, { kind: "assistant", text: "" }];
    expect(project(turns.map(turn => record(turn.kind, turn))).turns).toEqual(turns);
    expect(project([{ kind: "user", text: "old record without provenance" }]).turns)
      .toEqual([{ kind: "user", text: "old record without provenance" }]);
  });

  test("ignores non-record JSON, unknown kinds and malformed legacy text", () => {
    expect(project([null, false, 4, "string", [], {}, { kind: "user", text: {} },
      { kind: "assistant", text: 1 }, { kind: "unknown", text: "ignored" }]).turns).toEqual([]);
  });

  test("rejects malformed response IDs and text without merging into valid entries", () => {
    const invalidIds = [undefined, null, false, 2, {}, [], "", " ", "r\n", "r".repeat(257)];
    const records: unknown[] = [delta("r", "valid")];
    for (const responseId of invalidIds) records.push(delta(responseId, "bad"), final(responseId, "bad"));
    for (const text of [undefined, null, 1, {}, [], "x".repeat(2 * 1024 * 1024 + 1)]) {
      records.push(delta("r", text), final("r", text));
    }
    expect(project(records).turns).toEqual([{ kind: "assistant", text: "valid" }]);
  });

  test("bounds accumulated UTF-8 response bytes and permits canonical replacement after overflow", () => {
    const maximum = "é".repeat(1024 * 1024);
    expect(project([delta("r", maximum), delta("r", "overflow")]).turns)
      .toEqual([{ kind: "assistant", text: maximum }]);
    expect(project([delta("r", maximum), delta("r", "overflow"), final("r", "bounded final")]).turns)
      .toEqual([{ kind: "assistant", text: "bounded final" }]);
  });

  test("rejects malformed tool updates atomically without corrupting existing activity", () => {
    const invalid = [
      { activityId: {} }, { activityId: "" }, { activityId: "a".repeat(257) },
      { name: 1 }, { name: "" }, { name: "n".repeat(257) },
      { input: {} }, { input: "i".repeat(4097) },
      { output: null }, { output: [] }, { output: "o".repeat(4097) }, { error: "false" },
    ];
    const records = [tool(), ...invalid.map(fields => tool({ output: "must not merge", ...fields }))];
    expect(project(records).turns).toEqual([{ kind: "tool", name: "tool", input: "Tool activity in progress" }]);
    for (const fields of invalid) expect(entryFragments("antigravity", tool(fields))).toEqual([]);
  });

  test("uses safe identity maps even for object prototype property names", () => {
    const records = ["__proto__", "constructor", "toString"].flatMap(id => [
      delta(id, "draft"), tool({ activityId: id }), final(id, id), tool({ activityId: id, output: "Tool activity completed" }),
    ]);
    const turns = project(records).turns;
    expect(turns).toHaveLength(6);
    expect(turns.filter(turn => turn.kind === "assistant").map(turn => turn.text))
      .toEqual(["__proto__", "constructor", "toString"]);
    expect(({} as Record<string, unknown>).output).toBeUndefined();
  });

  test("search exposes delta/final text and generic tool fields, ignoring raw payload extras", () => {
    expect(entryFragments("antigravity", delta("r", "partial words")))
      .toEqual([{ kind: "assistant", text: "partial words" }]);
    expect(entryFragments("antigravity", final("r", "canonical words")))
      .toEqual([{ kind: "assistant", text: "canonical words" }]);
    const entry = tool({ output: "Tool activity completed", arguments: { token: "secret" }, auth: "secret", rawOutput: "secret" });
    expect(entryFragments("antigravity", entry)).toEqual([
      { kind: "tool", text: "tool Tool activity in progress" }, { kind: "tool", text: "Tool activity completed" },
    ]);
    expect(JSON.stringify(project([entry]))).not.toContain("secret");
    expect(entryFragments("antigravity", delta({}, "invalid"))).toEqual([]);
    expect(entryFragments("antigravity", null as any)).toEqual([]);
  });

  test("new records retain existing locateTranscript provenance and namespace checks", () => {
    const previous = process.env.AGENTMGR_HOME;
    const root = mkdtempSync(join(tmpdir(), "am-projection-"));
    process.env.AGENTMGR_HOME = root;
    try {
      const path = antigravityTranscriptPath("projection", provenance.createdAt, provenance.sessionId);
      mkdirSync(dirname(path), { recursive: true });
      const agent = { name: "projection", provider: "antigravity" as const, status: "idle" as const,
        dir: provenance.dir, createdAt: provenance.createdAt, updatedAt: provenance.timestamp,
        tmuxSession: "fixture", sessionId: provenance.sessionId, transcriptPath: path };
      writeFileSync(path, jsonl([delta("r", "partial"), tool()]) + "\n");
      expect(locateTranscript(agent)).toBe(path);
      expect(transcriptJson(agent).entries).toEqual([
        { index: 0, kind: "assistant", text: "partial" },
        { index: 1, kind: "tool", name: "tool", input: "Tool activity in progress" },
      ]);
      appendFileSync(path, jsonl([final("r", "final"), tool({ output: "Tool activity completed" }), record("user", { text: "next" })]) + "\n");
      expect(transcriptJson(agent)).toMatchObject({ total: 3, entries: [
        { index: 0, kind: "assistant", text: "final" },
        { index: 1, kind: "tool", name: "tool", input: "Tool activity in progress", output: "Tool activity completed" },
        { index: 2, kind: "user", text: "next" },
      ] });
      expect(transcriptJson(agent, 1).entries.map(entry => entry.index)).toEqual([1, 2]);
      for (const mismatch of [{ createdAt: "old-incarnation" }, { sessionId: "other-conversation" }]) {
        writeFileSync(path, jsonl([delta("r", "partial"), tool(mismatch)]));
        expect(() => locateTranscript(agent)).toThrow(/provenance/);
      }
      expect(() => locateTranscript({ ...agent, transcriptPath: join(root, "other.jsonl") })).toThrow(/bound/);
      rmSync(path);
      const target = join(root, "target.jsonl");
      writeFileSync(target, jsonl([final("r", "final")]));
      symlinkSync(target, path);
      expect(() => locateTranscript(agent)).toThrow(/namespace/);
    } finally {
      if (previous === undefined) delete process.env.AGENTMGR_HOME;
      else process.env.AGENTMGR_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
