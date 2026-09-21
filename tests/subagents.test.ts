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
  subagentActivity,
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
    expect(summarize([started("a", "Explore"), started("b", "code-review")])).toEqual({
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
