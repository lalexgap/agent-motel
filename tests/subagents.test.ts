import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
} from "../src/subagents";
import { formatSubagentLines, subagentLines } from "../src/commands/subagents";
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

    closeOpenSubagents("api", "2026-09-21T10:05:00.000Z");
    const records = readSubagents("api");
    expect(records.every((r) => r.endedAt)).toBe(true);
    expect(records.find((r) => r.id === "a1")!.endedAt).toBe("2026-09-21T10:05:00.000Z");
    // The already-finished one keeps its own end time and message.
    expect(records.find((r) => r.id === "a2")!.message).toBe("done");
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
  function agentWithTranscript(lines: string[], provider: AgentState["provider"] = "claude"): AgentState {
    const file = join(home, "session.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    return {
      name: "api",
      status: "working",
      dir: "/tmp",
      tmuxSession: "agentmgr-api",
      provider,
      transcriptPath: file,
      createdAt: "2026-09-21T10:00:00.000Z",
      updatedAt: "2026-09-21T10:00:00.000Z",
    };
  }

  const sidechain = (agentId: string, content: unknown[]) =>
    JSON.stringify({ type: "assistant", isSidechain: true, agentId, message: { role: "assistant", content } });

  test("reports each subagent's latest tool call or reply, keyed by id", () => {
    const agent = agentWithTranscript([
      JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "parent" }] } }),
      sidechain("sub-a", [{ type: "tool_use", name: "Grep", input: { pattern: "hook" } }]),
      sidechain("sub-a", [{ type: "text", text: "Found it in hook.ts" }]),
      sidechain("sub-b", [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } }]),
    ]);

    const activity = subagentActivity(agent);
    expect(activity.get("sub-a")).toBe("Found it in hook.ts");
    expect(activity.get("sub-b")).toContain("Read");
    expect(activity.has("parent")).toBe(false);
  });

  test("codex keeps subagent turns out of the parent rollout — no live line", () => {
    const agent = agentWithTranscript([sidechain("sub-a", [{ type: "text", text: "x" }])], "codex");
    expect(subagentActivity(agent).size).toBe(0);
  });

  test("a missing session file is not an error", () => {
    const agent = agentWithTranscript([]);
    agent.transcriptPath = join(home, "gone.jsonl");
    agent.sessionId = undefined;
    expect(subagentActivity(agent).size).toBe(0);
  });
});
