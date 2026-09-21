import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentsFile } from "../src/paths";
import type { AgentState } from "../src/state";
import {
  activeSubagents,
  clipMessage,
  closeOpenSubagents,
  listSubagentLedgers,
  readSubagents,
  recordSubagentStart,
  recordSubagentStop,
  renameSubagents,
  describeToolCall,
  isHarnessNoise,
  renderSubagentScreen,
  renderToolResult,
  subagentActivity,
  summarizeToolOutput,
  subagentSummary,
  summarize,
  type SubagentRecord,
} from "../src/subagents";
import {
  columnWidths,
  formatSubagentLines,
  jsonRecords,
  subagentHeader,
  subagentLines,
  subagentRows,
} from "../src/commands/subagents";
import { recordSubagentEvent } from "../src/commands/hook";
import { matchSubagent } from "../src/commands/transcript";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-subagents-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("subagent ledger", () => {
  test("start then stop folds into one finished record", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore", at: "2026-09-21T10:00:00.000Z" });
    recordSubagentStop("api", {
      id: "a1",
      type: "Explore",
      message: "found the hook handlers in src/commands/hook.ts",
      transcriptPath: "/tmp/sub-a1.jsonl",
      at: "2026-09-21T10:01:00.000Z",
    });

    const records = readSubagents("api");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "a1",
      type: "Explore",
      startedAt: "2026-09-21T10:00:00.000Z",
      endedAt: "2026-09-21T10:01:00.000Z",
      transcriptPath: "/tmp/sub-a1.jsonl",
    });
    expect(records[0]!.message).toContain("found the hook handlers");
    expect(activeSubagents("api")).toHaveLength(0);
  });

  test("a running subagent stays active until its stop", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    expect(activeSubagents("api").map((r) => r.id)).toEqual(["a1"]);
    recordSubagentStop("api", { id: "a1" });
    expect(activeSubagents("api")).toHaveLength(0);
  });

  test("a turn boundary closes subagents that never reported a stop", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    recordSubagentStart("api", { id: "a2", type: "code-review" });
    recordSubagentStop("api", { id: "a2", message: "done" });

    closeOpenSubagents("api", { at: "2026-09-21T10:05:00.000Z" });
    const records = readSubagents("api");
    expect(records.every((r) => r.endedAt)).toBe(true);
    expect(records.find((r) => r.id === "a1")!.endedAt).toBe("2026-09-21T10:05:00.000Z");
    // The already-finished one keeps its own end time and message.
    expect(records.find((r) => r.id === "a2")!.message).toBe("done");
  });

  test("a spared subagent stays open while the rest close", () => {
    recordSubagentStart("api", { id: "fg", type: "Explore" });
    recordSubagentStart("api", { id: "bg", type: "code-review" });
    // Forked subagents outlive the turn and report their own stop later.
    closeOpenSubagents("api", { at: "2026-09-21T10:05:00.000Z", keepOpen: (r) => r.id === "bg" });
    expect(activeSubagents("api").map((r) => r.id)).toEqual(["bg"]);

    recordSubagentStop("api", { id: "bg", message: "3 findings", at: "2026-09-21T10:07:00.000Z" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("sparing every open subagent writes nothing at all", () => {
    recordSubagentStart("api", { id: "bg", type: "code-review" });
    const before = readFileSync(subagentsFile("api"), "utf8");
    closeOpenSubagents("api", { keepOpen: () => true });
    expect(readFileSync(subagentsFile("api"), "utf8")).toBe(before);
  });

  test("closing is a no-op when nothing is open", () => {
    recordSubagentStart("api", { id: "a1" });
    recordSubagentStop("api", { id: "a1" });
    const before = readFileSync(subagentsFile("api"), "utf8");
    closeOpenSubagents("api");
    expect(readFileSync(subagentsFile("api"), "utf8")).toBe(before);
  });

  test("ledgers are per-agent, listable, and renameable", () => {
    recordSubagentStart("api", { id: "a1" });
    recordSubagentStart("web", { id: "b1" });
    expect(listSubagentLedgers().map((l) => l.name).sort()).toEqual(["api", "web"]);

    renameSubagents("api", "api2");
    expect(readSubagents("api")).toHaveLength(0);
    expect(readSubagents("api2")).toHaveLength(1);
    expect(() => renameSubagents("api2", "web")).toThrow(/already exists/);
  });

  test("a torn last line doesn't lose the rest of the ledger", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    writeFileSync(subagentsFile("api"), readFileSync(subagentsFile("api"), "utf8") + '{"ev":"sta');
    expect(readSubagents("api").map((r) => r.id)).toEqual(["a1"]);
  });

  test("missing ledger reads as empty, not an error", () => {
    expect(readSubagents("nobody")).toEqual([]);
    expect(subagentSummary("nobody")).toBeNull();
  });
});

describe("summarize", () => {
  const started = (id: string, type: string) => ({ id, type, startedAt: "2026-09-21T10:00:00.000Z" });

  test("counts only what's running and names the types", () => {
    expect(summarize([started("a", "Explore"), started("b", "code-review")])).toMatchObject({
      active: 2,
      types: "code-review, Explore",
      detail: "2 subagents · code-review, Explore",
    });
  });

  test("singular for one, and repeated types collapse", () => {
    expect(summarize([started("a", "Explore")])!.detail).toBe("1 subagent · Explore");
    expect(summarize([started("a", "Explore"), started("b", "Explore")])!.detail)
      .toBe("2 subagents · Explore");
  });

  test("a wide fan-out is capped with a +n", () => {
    const wide = [started("a", "one"), started("b", "two"), started("c", "three"), started("d", "four")];
    expect(summarize(wide)!.detail).toBe("4 subagents · four, three +2");
  });

  test("carries the running records for the sidebar's nested rows, capped", () => {
    const summary = summarize([started("a", "Explore"), started("b", "code-review")])!;
    expect(summary.running!.map((r) => r.id)).toEqual(["a", "b"]);
    const many = Array.from({ length: 12 }, (_, i) => started(`s${i}`, "Explore"));
    // The most recent stay; a runaway fan-out can't swamp the list.
    expect(summarize(many)!.running!.map((r) => r.id)).toEqual(["s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11"]);
    expect(summarize(many)!.active).toBe(12);
  });

  test("finished records summarize to nothing", () => {
    expect(summarize([{ ...started("a", "Explore"), endedAt: "2026-09-21T10:01:00.000Z" }])).toBeNull();
  });
});

describe("clipMessage", () => {
  test("flattens whitespace and caps length", () => {
    expect(clipMessage("two\n\nlines  here")).toBe("two lines here");
    const long = "x".repeat(400);
    expect(clipMessage(long)).toHaveLength(200);
    expect(clipMessage(long).endsWith("…")).toBe(true);
  });
});

describe("am subagents output", () => {
  const records = [
    { id: "aaaa1111bbbb", type: "Explore", startedAt: "2026-09-21T10:00:00.000Z" },
    {
      id: "cccc2222dddd",
      type: "code-review",
      startedAt: "2026-09-21T10:00:00.000Z",
      endedAt: "2026-09-21T10:02:00.000Z",
      message: "3 findings",
    },
  ];

  test("running first, with live activity; finished show their answer", () => {
    const lines = subagentLines(
      records,
      new Map([["aaaa1111bbbb", "Grep hook handlers"]]),
      Date.parse("2026-09-21T10:01:00.000Z"),
    );
    expect(lines.map((l) => l.icon)).toEqual(["●", "✔"]);
    expect(lines[0]).toMatchObject({ type: "Explore", id: "aaaa1111", age: "1m0s", detail: "Grep hook handlers" });
    expect(lines[1]).toMatchObject({ type: "code-review", age: "2m0s", detail: "3 findings" });
  });

  test("a gone session's open records read as ended, not running", () => {
    const lines = subagentLines(records, new Map(), Date.parse("2026-09-21T10:03:00.000Z"), { live: false });
    expect(lines[0]).toMatchObject({ icon: "✕", type: "Explore", detail: "ended with the session" });
    // A genuinely finished one is unaffected.
    expect(lines[1]).toMatchObject({ icon: "✔", detail: "3 findings" });
  });

  test("no activity and no message renders a placeholder", () => {
    const [line] = subagentLines([records[0]!], new Map(), Date.parse("2026-09-21T10:00:30.000Z"));
    expect(line!.detail).toBe("—");
  });

  test("formatted table has a header and one row per subagent", () => {
    const out = formatSubagentLines(subagentLines(records, new Map()));
    expect(out[0]).toContain("TYPE");
    expect(out).toHaveLength(3);
    expect(out[1]).toContain("Explore");
  });

  test("shared widths line every group up under one header", () => {
    const narrow = subagentLines([records[0]!], new Map());
    const wide = subagentLines(
      [{ id: "eeee3333", type: "general-purpose", startedAt: "2026-09-21T10:00:00.000Z" }],
      new Map(),
    );
    const widths = columnWidths([...narrow, ...wide]);
    const header = subagentHeader(widths);
    const [narrowRow] = subagentRows(narrow, widths);
    const [wideRow] = subagentRows(wide, widths);
    // The ID column starts at the same offset in the header and in every row.
    expect(narrowRow!.indexOf("aaaa1111")).toBe(header.indexOf("ID"));
    expect(wideRow!.indexOf("eeee3333")).toBe(header.indexOf("ID"));
  });
});

describe("jsonRecords", () => {
  const open = { id: "a1", type: "Explore", startedAt: "2026-09-21T10:00:00.000Z" };
  const done = { ...open, id: "a2", endedAt: "2026-09-21T10:01:00.000Z" };

  test("a live agent's records pass through untouched", () => {
    expect(jsonRecords([open, done], true)).toEqual([open, done]);
  });

  test("a gone agent's open records are marked stale, finished ones aren't", () => {
    const [first, second] = jsonRecords([open, done], false);
    expect(first).toMatchObject({ id: "a1", stale: true });
    expect(second).toEqual(done);
  });
});

describe("recordSubagentEvent", () => {
  const agent: AgentState = {
    name: "api",
    status: "working",
    dir: "/tmp",
    tmuxSession: "agentmgr-api",
    provider: "claude",
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
  };

  test("a new session closes the previous one's leftovers", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // The session was killed: no stop hook ever ran for a1.
    recordSubagentEvent("session-start", agent, {});
    expect(activeSubagents("api")).toEqual([]);
  });

  test("start and stop payloads fold into a record", () => {
    recordSubagentEvent("subagent-start", agent, { agent_id: "b1", agent_type: "code-review" });
    expect(activeSubagents("api").map((r) => r.type)).toEqual(["code-review"]);
    recordSubagentEvent("subagent-stop", agent, {
      agent_id: "b1",
      agent_type: "code-review",
      last_assistant_message: "3 findings",
      agent_transcript_path: "/tmp/b1.jsonl",
    });
    expect(readSubagents("api")[0]).toMatchObject({ message: "3 findings", transcriptPath: "/tmp/b1.jsonl" });
  });

  test("an interrupted turn's leftovers are closed when the next turn starts", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // ESC (or `am interrupt`) aborts the turn: no stop hook ever fires.
    recordSubagentEvent("user-prompt-submit", agent, {});
    expect(activeSubagents("api")).toEqual([]);
  });

  test("a reused id starts a fresh run instead of resurrecting a closed one", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore", at: "2026-09-21T10:00:00.000Z" });
    recordSubagentStop("api", { id: "a1", message: "first", at: "2026-09-21T10:01:00.000Z" });
    recordSubagentStart("api", { id: "a1", type: "Explore", at: "2026-09-21T10:02:00.000Z" });

    const [record] = readSubagents("api");
    expect(record).toMatchObject({ startedAt: "2026-09-21T10:02:00.000Z" });
    expect(record!.endedAt).toBeUndefined();
    expect(record!.message).toBeUndefined();
    expect(activeSubagents("api")).toHaveLength(1);
  });

  test("auto-compaction's session start does not close a live fan-out", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    recordSubagentEvent("session-start", agent, { source: "compact" });
    expect(activeSubagents("api")).toHaveLength(1);
    recordSubagentEvent("session-start", agent, { source: "resume" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("going idle is a boundary however it happened — including the idle notification", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // Esc aborts the turn (no stop hook); claude's "waiting for your input"
    // notification is what tells am the agent went idle.
    recordSubagentEvent("notification", agent, { message: "Claude is waiting for your input" }, { status: "idle" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("mid-turn events are not boundaries", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    recordSubagentEvent("post-tool-use", agent, {}, { status: "working" });
    recordSubagentEvent("notification", agent, { message: "needs your permission" }, { status: "needs-attention" });
    expect(activeSubagents("api")).toHaveLength(1);
  });

  test("a session boundary closes everything, background included", () => {
    recordSubagentStart("api", { id: "bg", type: "code-review" });
    // No provider process survives, so nothing it spawned can still be live —
    // and a leftover background marker must not outlast the session.
    recordSubagentEvent("session-end", agent, {}, { status: "exited" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("a boundary event from inside a subagent is not the parent's boundary", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // agent_id is set only when a hook fires from within a subagent.
    recordSubagentEvent("stop", agent, { agent_id: "a1" }, { status: "idle" });
    expect(activeSubagents("api")).toHaveLength(1);
  });

  test("a payload without an agent id is ignored, not recorded", () => {
    recordSubagentEvent("subagent-start", agent, {});
    expect(readSubagents("api")).toEqual([]);
  });
});

describe("matchSubagent", () => {
  const records = [
    { id: "aaaa1111", type: "Explore", startedAt: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T10:01:00.000Z" },
    { id: "aaaa2222", type: "Explore", startedAt: "2026-09-21T10:02:00.000Z" },
    { id: "bbbb3333", type: "code-review", startedAt: "2026-09-21T10:03:00.000Z" },
  ];

  test("matches an exact id, an unambiguous prefix, and the latest of a type", () => {
    expect(matchSubagent(records, "aaaa1111")!.id).toBe("aaaa1111");
    expect(matchSubagent(records, "bbbb")!.id).toBe("bbbb3333");
    expect(matchSubagent(records, "explore")!.id).toBe("aaaa2222");
  });

  test("an ambiguous id prefix is an error, an unknown query is null", () => {
    expect(() => matchSubagent(records, "aaaa")).toThrow(/longer id/);
    expect(matchSubagent(records, "nope")).toBeNull();
  });
});

describe("subagentActivity", () => {
  // Claude Code writes each subagent's turns to its own file beside the
  // parent's transcript: <session-id>/subagents/agent-<agent_id>.jsonl.
  function agentWithSubagentFiles(
    subagents: Record<string, string[]>,
    provider: AgentState["provider"] = "claude",
  ): AgentState {
    const parent = join(home, "session.jsonl");
    writeFileSync(parent, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "parent" }] } }) + "\n");
    const dir = join(home, "session", "subagents");
    mkdirSync(dir, { recursive: true });
    for (const [id, lines] of Object.entries(subagents)) {
      writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join("\n") + "\n");
    }
    return {
      name: "api",
      status: "working",
      dir: "/tmp",
      tmuxSession: "agentmgr-api",
      provider,
      transcriptPath: parent,
      createdAt: "2026-09-21T10:00:00.000Z",
      updatedAt: "2026-09-21T10:00:00.000Z",
    };
  }

  const turn = (content: unknown[]) =>
    JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content } });
  const record = (id: string): SubagentRecord => ({ id, type: "Explore", startedAt: "2026-09-21T10:00:00.000Z" });

  test("reports each subagent's latest tool call or reply from its own file", () => {
    const agent = agentWithSubagentFiles({
      "sub-a": [turn([{ type: "tool_use", name: "Grep", input: { pattern: "hook" } }]), turn([{ type: "text", text: "Found it in hook.ts" }])],
      "sub-b": [turn([{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }])],
    });

    const activity = subagentActivity(agent, [record("sub-a"), record("sub-b")]);
    expect(activity.get("sub-a")).toBe("Found it in hook.ts");
    expect(activity.get("sub-b")).toContain("Read");
    // The parent's own turns are in a different file and never leak in.
    expect([...activity.values()].some((v) => v.includes("parent"))).toBe(false);
  });

  test("a recorded transcript path wins over the derived one", () => {
    const agent = agentWithSubagentFiles({ "sub-a": [turn([{ type: "text", text: "derived" }])] });
    const own = join(home, "own.jsonl");
    writeFileSync(own, turn([{ type: "text", text: "reported" }]) + "\n");
    const activity = subagentActivity(agent, [{ ...record("sub-a"), transcriptPath: own }]);
    expect(activity.get("sub-a")).toBe("reported");
  });

  test("codex reports no transcript until its subagent stops — no live line", () => {
    const agent = agentWithSubagentFiles({ "sub-a": [turn([{ type: "text", text: "x" }])] }, "codex");
    expect(subagentActivity(agent, [record("sub-a")]).size).toBe(0);
  });

  test("a subagent with no file yet is skipped, not an error", () => {
    const agent = agentWithSubagentFiles({});
    expect(subagentActivity(agent, [record("sub-a")]).size).toBe(0);
  });

  test("an unlocatable parent transcript yields no activity", () => {
    const agent = agentWithSubagentFiles({});
    agent.transcriptPath = join(home, "gone.jsonl");
    expect(subagentActivity(agent, [record("sub-a")]).size).toBe(0);
  });
});

describe("jsonRecords", () => {
  const open = { id: "a1", type: "Explore", startedAt: "2026-09-21T10:00:00.000Z" };
  const done = { ...open, id: "a2", endedAt: "2026-09-21T10:01:00.000Z" };

  test("a live agent's records pass through untouched", () => {
    expect(jsonRecords([open, done], true)).toEqual([open, done]);
  });

  test("a gone agent's open records are marked stale, finished ones aren't", () => {
    const [first, second] = jsonRecords([open, done], false);
    expect(first).toMatchObject({ id: "a1", stale: true });
    expect(second).toEqual(done);
  });
});

describe("recordSubagentEvent", () => {
  const agent: AgentState = {
    name: "api",
    status: "working",
    dir: "/tmp",
    tmuxSession: "agentmgr-api",
    provider: "claude",
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
  };

  test("a new session closes the previous one's leftovers", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // The session was killed: no stop hook ever ran for a1.
    recordSubagentEvent("session-start", agent, {});
    expect(activeSubagents("api")).toEqual([]);
  });

  test("start and stop payloads fold into a record", () => {
    recordSubagentEvent("subagent-start", agent, { agent_id: "b1", agent_type: "code-review" });
    expect(activeSubagents("api").map((r) => r.type)).toEqual(["code-review"]);
    recordSubagentEvent("subagent-stop", agent, {
      agent_id: "b1",
      agent_type: "code-review",
      last_assistant_message: "3 findings",
      agent_transcript_path: "/tmp/b1.jsonl",
    });
    expect(readSubagents("api")[0]).toMatchObject({ message: "3 findings", transcriptPath: "/tmp/b1.jsonl" });
  });

  test("an interrupted turn's leftovers are closed when the next turn starts", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // ESC (or `am interrupt`) aborts the turn: no stop hook ever fires.
    recordSubagentEvent("user-prompt-submit", agent, {});
    expect(activeSubagents("api")).toEqual([]);
  });

  test("a reused id starts a fresh run instead of resurrecting a closed one", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore", at: "2026-09-21T10:00:00.000Z" });
    recordSubagentStop("api", { id: "a1", message: "first", at: "2026-09-21T10:01:00.000Z" });
    recordSubagentStart("api", { id: "a1", type: "Explore", at: "2026-09-21T10:02:00.000Z" });

    const [record] = readSubagents("api");
    expect(record).toMatchObject({ startedAt: "2026-09-21T10:02:00.000Z" });
    expect(record!.endedAt).toBeUndefined();
    expect(record!.message).toBeUndefined();
    expect(activeSubagents("api")).toHaveLength(1);
  });

  test("auto-compaction's session start does not close a live fan-out", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    recordSubagentEvent("session-start", agent, { source: "compact" });
    expect(activeSubagents("api")).toHaveLength(1);
    recordSubagentEvent("session-start", agent, { source: "resume" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("going idle is a boundary however it happened — including the idle notification", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // Esc aborts the turn (no stop hook); claude's "waiting for your input"
    // notification is what tells am the agent went idle.
    recordSubagentEvent("notification", agent, { message: "Claude is waiting for your input" }, { status: "idle" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("mid-turn events are not boundaries", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    recordSubagentEvent("post-tool-use", agent, {}, { status: "working" });
    recordSubagentEvent("notification", agent, { message: "needs your permission" }, { status: "needs-attention" });
    expect(activeSubagents("api")).toHaveLength(1);
  });

  test("a session boundary closes everything, background included", () => {
    recordSubagentStart("api", { id: "bg", type: "code-review" });
    // No provider process survives, so nothing it spawned can still be live —
    // and a leftover background marker must not outlast the session.
    recordSubagentEvent("session-end", agent, {}, { status: "exited" });
    expect(activeSubagents("api")).toEqual([]);
  });

  test("a boundary event from inside a subagent is not the parent's boundary", () => {
    recordSubagentStart("api", { id: "a1", type: "Explore" });
    // agent_id is set only when a hook fires from within a subagent.
    recordSubagentEvent("stop", agent, { agent_id: "a1" }, { status: "idle" });
    expect(activeSubagents("api")).toHaveLength(1);
  });

  test("a payload without an agent id is ignored, not recorded", () => {
    recordSubagentEvent("subagent-start", agent, {});
    expect(readSubagents("api")).toEqual([]);
  });
});

describe("matchSubagent", () => {
  const records = [
    { id: "aaaa1111", type: "Explore", startedAt: "2026-09-21T10:00:00.000Z", endedAt: "2026-09-21T10:01:00.000Z" },
    { id: "aaaa2222", type: "Explore", startedAt: "2026-09-21T10:02:00.000Z" },
    { id: "bbbb3333", type: "code-review", startedAt: "2026-09-21T10:03:00.000Z" },
  ];

  test("matches an exact id, an unambiguous prefix, and the latest of a type", () => {
    expect(matchSubagent(records, "aaaa1111")!.id).toBe("aaaa1111");
    expect(matchSubagent(records, "bbbb")!.id).toBe("bbbb3333");
    expect(matchSubagent(records, "explore")!.id).toBe("aaaa2222");
  });

  test("an ambiguous id prefix is an error, an unknown query is null", () => {
    expect(() => matchSubagent(records, "aaaa")).toThrow(/longer id/);
    expect(matchSubagent(records, "nope")).toBeNull();
  });
});

describe("renderSubagentScreen", () => {
  test("lays turns out like the provider's transcript view, results folded to a line", () => {
    const lines = renderSubagentScreen([
      { kind: "user", text: "find the hook handlers\nand report back" },
      { kind: "assistant", text: "Looking now." },
      { kind: "tool", name: "Grep", input: "{\"pattern\":\"hook\"}", output: "src/hook.ts:12\nsrc/hook.ts:40" },
      { kind: "tool", name: "Bash", input: "{\"command\":\"sleep 5\"}", output: "" },
      { kind: "assistant", text: "They live in hook.ts.\nTwo handlers." },
    ]);
    expect(lines).toEqual([
      "❯ find the hook handlers and report back",
      "",
      "⏺ Looking now.",
      "",
      "⏺ Grep(hook)",
      "  ⎿  Found 2 results",
      "⏺ Bash(sleep 5)",
      "  ⎿  (no output)",
      "",
      "⏺ They live in hook.ts.",
      "  Two handlers.",
    ]);
  });

  test("a call still in flight shows an ellipsis, and colors dim the result lines", () => {
    const lines = renderSubagentScreen(
      [{ kind: "tool", name: "Bash", input: "{\"command\":\"gh pr checks 1\"}" }],
      { colors: true },
    );
    expect(lines[0]).toBe("⏺ Bash(gh pr checks 1)");
    expect(lines[1]).toBe("\x1b[2m  ⎿  …\x1b[0m");
  });

  test("the trailing run of unanswered calls is in flight; earlier ones were cut off", () => {
    const turns = [
      { kind: "tool", name: "Bash", input: "{\"command\":\"a\"}" },
      { kind: "assistant", text: "Trying again." },
      { kind: "tool", name: "Bash", input: "{\"command\":\"b\"}" },
      { kind: "tool", name: "Read", input: "{\"file_path\":\"c\"}", output: "fast" },
      { kind: "tool", name: "Bash", input: "{\"command\":\"d\"}" },
    ] as const;
    expect(renderSubagentScreen([...turns])).toEqual([
      "⏺ Bash(a)",
      "  ⎿  (no result)",
      "",
      "⏺ Trying again.",
      "",
      "⏺ Bash(b)",
      "  ⎿  …",
      "⏺ Read(c)",
      "  ⎿  Read 1 line",
      "⏺ Bash(d)",
      "  ⎿  …",
    ]);
    const finished = renderSubagentScreen([...turns], { finished: true });
    expect(finished.filter((l) => l.includes("…"))).toEqual([]);
    expect(finished.filter((l) => l.includes("(no result)"))).toHaveLength(3);
  });

  test("blank lines inside a message stay blank, without doubling the gap after it", () => {
    const lines = renderSubagentScreen([
      { kind: "assistant", text: "One.\n\nTwo." },
      { kind: "assistant", text: "Three." },
    ]);
    expect(lines).toEqual(["⏺ One.", "", "  Two.", "", "⏺ Three."]);
  });

  test("harness-injected user turns are not the subagent's conversation", () => {
    const lines = renderSubagentScreen([
      { kind: "user", text: "Review target: `66`" },
      { kind: "user", text: "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event" },
      { kind: "user", text: "Base directory for this skill: /home/x/.claude/skills/review" },
      { kind: "user", text: "<system-reminder>\nOther agents are running" },
    ]);
    expect(lines).toEqual(["❯ Review target: `66`"]);
    expect(isHarnessNoise("  [Request interrupted by user]")).toBe(true);
    expect(isHarnessNoise("Review the diff")).toBe(false);
  });

  test("the first user turn is the brief even when it starts like harness noise", () => {
    const lines = renderSubagentScreen([
      { kind: "user", text: "Base directory for this skill: /x\n\nReview PR 66" },
      { kind: "user", text: "Base directory for this skill: /y" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("❯ Base directory for this skill: /x");
  });
});

describe("renderToolResult", () => {
  const call = (name: string, input: string, output: string | undefined, colors = false, error?: boolean) =>
    renderToolResult({ kind: "tool", name, input, output, ...(error ? { error } : {}) }, colors);

  test("an Edit is its diff, removed red and added green", () => {
    const lines = call(
      "Edit",
      JSON.stringify({ file_path: "/x/src/hook.ts", old_string: "const x = 1;", new_string: "const x = 2;\nconst y = 3;" }),
      "The file has been updated successfully.",
      true,
    );
    expect(lines).toEqual([
      "\x1b[2m  ⎿  Updated hook.ts with 2 additions and 1 removal\x1b[0m",
      "\x1b[31m       - const x = 1;\x1b[0m",
      "\x1b[32m       + const x = 2;\x1b[0m",
      "\x1b[32m       + const y = 3;\x1b[0m",
    ]);
  });

  test("a long diff is capped per side, long lines keep their indentation", () => {
    const old = Array.from({ length: 12 }, (_, i) => `old ${i}`).join("\n");
    const lines = call("Edit", JSON.stringify({ file_path: "a.ts", old_string: old, new_string: "" }), "ok");
    expect(lines.filter((l) => l.includes("- old"))).toHaveLength(8);
    expect(lines.at(-1)).toContain("… (+4 lines)");
    const wide = call("Edit", JSON.stringify({ file_path: "a.ts", old_string: "", new_string: "    " + "x".repeat(200) }), "ok");
    expect(wide[1]).toBe("       +     " + "x".repeat(95) + "…");
  });

  test("a replace-all Edit says its counts are per occurrence", () => {
    const lines = call("Edit", JSON.stringify({ file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true }), "ok");
    expect(lines[0]).toBe("  ⎿  Updated a.ts with 1 addition and 1 removal per occurrence");
  });

  test("a rejected or in-flight Edit is not shown as a diff that landed", () => {
    const input = JSON.stringify({ file_path: "a.ts", old_string: "a", new_string: "b" });
    expect(call("Edit", input, "<tool_use_error>String to replace not found in file.\nString: a</tool_use_error>", false, true))
      .toEqual(["  ⎿  String to replace not found in file. (+1 lines)"]);
    expect(call("Edit", input, undefined)).toEqual(["  ⎿  …"]);
    expect(call("Write", JSON.stringify({ file_path: "a.ts", content: "x" }), "<tool_use_error>File has not been read yet.</tool_use_error>", false, true))
      .toEqual(["  ⎿  File has not been read yet."]);
    expect(call("Read", "{}", "<tool_use_error>File does not exist.</tool_use_error>", false, true)).toEqual(["  ⎿  File does not exist."]);
    expect(call("Bash", "{}", "Exit code 1\nnot found", false, true)).toEqual(["  ⎿  Exit code 1", "  ⎿     not found"]);
  });

  test("a Write shows what it wrote; Read and searches say how much came back", () => {
    expect(call("Write", JSON.stringify({ file_path: "/x/notes.md", content: "a\nb\nc" }), "File created"))
      .toEqual(["  ⎿  Wrote 3 lines to notes.md", "       + a", "       + b", "       + c"]);
    expect(call("Read", "{}", "     1→import x\n     2→\n     3→export y\n\n<system-reminder>\nnote\n</system-reminder>")).toEqual(["  ⎿  Read 3 lines"]);
    expect(call("Read", "{}", "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"))
      .toEqual(["  ⎿  Read an empty file"]);
    expect(call("Grep", "{}", "src/a.ts:1:x\nsrc/b.ts:9:x")).toEqual(["  ⎿  Found 2 results"]);
    expect(call("Grep", "{}", "Found 2 files\nsrc/a.ts\nsrc/b.ts")).toEqual(["  ⎿  Found 2 files"]);
    expect(call("Glob", "{}", "No files found")).toEqual(["  ⎿  Found nothing"]);
  });

  test("an MCP tool that happens to share a built-in's name gets the generic summary", () => {
    expect(call("mcp__fs__Read", "{}", "     1→x\n     2→y")).toEqual(["  ⎿  1→x (+1 lines)"]);
  });

  test("a command shows its first lines and folds the rest", () => {
    const out = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const lines = call("Bash", JSON.stringify({ command: "gh pr checks 1" }), out);
    expect(lines).toEqual([
      "  ⎿  line 0",
      "  ⎿     line 1",
      "  ⎿     line 2",
      "  ⎿     line 3",
      "  ⎿     line 4",
      "  ⎿     … (+3 lines)",
    ]);
    expect(call("Bash", "{}", "")).toEqual(["  ⎿  (no output)"]);
    expect(call("Bash", "{}", undefined)).toEqual(["  ⎿  …"]);
  });

  test("harness text inside a result is not the result", () => {
    const out = "This agent is isolated in the worktree /x — do not cd elsewhere\nactual output\n<system-reminder>\nnoise\n</system-reminder>";
    expect(call("Bash", "{}", out)).toEqual(["  ⎿  actual output"]);
    expect(summarizeToolOutput(out)).toBe("actual output");
    const closedMidLine = "actual output\n<system-reminder>\nnoise\nmore noise</system-reminder>";
    expect(call("Bash", "{}", closedMidLine)).toEqual(["  ⎿  actual output"]);
  });
});

describe("summarizeToolOutput", () => {
  test("first line plus how much more, empty and in-flight spelled out", () => {
    expect(summarizeToolOutput("All checks were successful\n\nbuild  pass\ntest  pass")).toBe("All checks were successful (+2 lines)");
    expect(summarizeToolOutput("one line")).toBe("one line");
    expect(summarizeToolOutput("   \n")).toBe("(no output)");
    expect(summarizeToolOutput(undefined)).toBe("…");
    expect(summarizeToolOutput("x".repeat(300)).length).toBeLessThan(110);
  });

  test("terminal control sequences never reach the folded line", () => {
    expect(summarizeToolOutput("\x1b[2J\x1b[H\x1b[32mok\x1b[0m\x07\r\n\x1b]0;title\x07more\x1b[K")).toBe("ok (+1 lines)");
    expect(summarizeToolOutput("\x1b[1;1H\x1b[2K")).toBe("(no output)");
    expect(summarizeToolOutput("\x1b[38:5:1m\x1b(Bred\x1b]8;;http://x")).toBe("red");
  });

  test("reminders the harness appended after the result are not the result", () => {
    const reminder = "<system-reminder>\nOnly you see that output.\n</system-reminder>";
    expect(summarizeToolOutput(reminder)).toBe("(no output)");
    expect(summarizeToolOutput(`done\n\n${reminder}\n${reminder}`)).toBe("done");
    expect(summarizeToolOutput(`src/a.ts:1: "<system-reminder>"\nsrc/b.ts:2: x\n${reminder}`)).toBe(
      'src/a.ts:1: "<system-reminder>" (+1 lines)',
    );
  });
});

describe("describeToolCall", () => {
  test("shows the salient argument the way the provider's UI does, not the JSON", () => {
    expect(describeToolCall("Bash", '{"command":"sed -n 1,30p docs/x.md; echo ...","description":"Read docs"}')).toBe("Bash(sed -n 1,30p docs/x.md; echo ...)");
    expect(describeToolCall("Read", '{"file_path":"/home/x/src/hook.ts","limit":40}')).toBe("Read(/home/x/src/hook.ts)");
    expect(describeToolCall("Grep", '{"pattern":"inboxRootDir","path":"src"}')).toBe("Grep(inboxRootDir)");
    expect(describeToolCall("Agent", '{"subagent_type":"reviewer","description":"Review PR #74","prompt":"Review the diff"}')).toBe("Agent(Review PR #74)");
    expect(describeToolCall("Skill", '{"skill":"code-review","args":"main...HEAD high"}')).toBe("Skill(code-review main...HEAD high)");
  });

  test("mcp tools read as server:tool, and odd inputs degrade gracefully", () => {
    expect(describeToolCall("mcp__playwright__browser_click", '{"target":"[data-test=x] button","element":"Undo change button"}')).toBe("playwright:browser_click([data-test=x] button)");
    expect(describeToolCall("mcp__playwright__browser_close", "{}")).toBe("playwright:browser_close()");
    expect(describeToolCall("shell", "ls -la")).toBe("shell(ls -la)");
    expect(describeToolCall("shell", '{"command":["bash","-lc","git status"],"workdir":"/x"}')).toBe("shell(bash -lc git status)");
    expect(describeToolCall("shell", '["bash","-lc","git status"]')).toBe('shell(["bash","-lc","git status"])');
    expect(describeToolCall("sql", '{"sql":"SELECT\\n  a,\\n  b\\nFROM t"}')).toBe("sql(SELECT a, b FROM t)");
    expect(describeToolCall("mcp__claude_ai_Product_Hunt__product_hunt_graphql", '{"query":"query { posts }"}')).toBe("claude_ai_Product_Hunt:product_hunt_graphql(query { posts })");
    expect(describeToolCall("Weird", '{"count":3}')).toBe('Weird({"count":3})');
    expect(describeToolCall("Bash", `{"command":"${"x".repeat(300)}"}`).length).toBeLessThan(120);
  });
});
