import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAgentMatches, search, type SearchResult } from "../src/search";
import { entryFragments } from "../src/transcript";
import { writeAgent, type AgentState } from "../src/state";
import { trashState } from "../src/trash";

// entryFragments is the shared noise filter `am search` leans on: it must drop
// harness banners, sidechains, and structural lines while keeping real chat.
describe("entryFragments", () => {
  test("claude user string message becomes a user fragment", () => {
    const frags = entryFragments("claude", { type: "user", message: { content: "hello worktree" } });
    expect(frags).toEqual([{ kind: "user", text: "hello worktree" }]);
  });

  test("claude harness-prefixed user message is dropped", () => {
    const frags = entryFragments("claude", {
      type: "user",
      message: { content: "<system-reminder>secret worktree</system-reminder>" },
    });
    expect(frags).toEqual([]);
  });

  test("claude sidechain and meta entries are dropped", () => {
    expect(entryFragments("claude", { type: "user", isSidechain: true, message: { content: "x" } })).toEqual([]);
    expect(entryFragments("claude", { type: "assistant", isMeta: true, message: { content: [] } })).toEqual([]);
  });

  test("claude assistant text and tool_use split into labeled fragments", () => {
    const frags = entryFragments("claude", {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "the answer is banana" },
          { type: "tool_use", name: "Read", input: { file_path: "/x/banana.ts" } },
        ],
      },
    });
    expect(frags[0]).toEqual({ kind: "assistant", text: "the answer is banana" });
    expect(frags[1]?.kind).toBe("tool");
    expect(frags[1]?.text).toContain("banana.ts");
  });

  test("codex user message becomes a user fragment; harness context dropped", () => {
    const ok = entryFragments("codex", {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ text: "ship the worktree" }] },
    });
    expect(ok).toEqual([{ kind: "user", text: "ship the worktree" }]);
    const harness = entryFragments("codex", {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ text: "<environment_context>cwd</environment_context>" }] },
    });
    expect(harness).toEqual([]);
  });
});

let home: string;

function claudeLine(type: "user" | "assistant", content: unknown): string {
  return JSON.stringify({ type, sessionId: "sid", cwd: "/tmp/x", timestamp: new Date().toISOString(), message: { content } });
}

function writeTranscript(lines: string[]): string {
  const file = join(home, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function agent(name: string, transcriptPath: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return {
    name,
    status: "exited",
    dir: `/tmp/${name}`,
    tmuxSession: `agentmgr-${name}`,
    transcriptPath,
    sessionId: "sid",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("search (local corpus)", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-search-"));
    process.env.AGENTMGR_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  test("finds a term in a registered agent's chat and yields a resume command", () => {
    const file = writeTranscript([claudeLine("user", "please add a banana to the parser")]);
    writeAgent(agent("parser", file));
    const [hit, ...rest] = search("banana");
    expect(rest).toHaveLength(0);
    expect(hit?.agentName).toBe("parser");
    expect(hit?.action).toBe("resume");
    expect(hit?.command).toBe("am resume parser");
    const snippet = hit!.snippets[0]!;
    expect(snippet.kind).toBe("user");
    expect(snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLen).toLowerCase()).toBe("banana");
  });

  test("a hit only inside a harness banner produces no result", () => {
    const file = writeTranscript([claudeLine("user", "<system-reminder>banana zone</system-reminder>")]);
    writeAgent(agent("ghost", file));
    expect(search("banana")).toHaveLength(0);
  });

  test("conversational snippets are surfaced ahead of tool hits", () => {
    const file = writeTranscript([
      claudeLine("assistant", [{ type: "tool_use", name: "Read", input: { file_path: "/x/banana.ts" } }]),
      claudeLine("assistant", [{ type: "text", text: "I renamed it to banana finally" }]),
    ]);
    writeAgent(agent("worker", file));
    const hit = search("banana")[0]!;
    expect(hit.snippets[0]?.kind).toBe("assistant");
  });

  test("matches in trashed agents map to a restore command", () => {
    const file = writeTranscript([claudeLine("user", "the kumquat experiment")]);
    trashState(agent("removed", file));
    const hit = search("kumquat")[0]!;
    expect(hit.scope).toBe("trash");
    expect(hit.action).toBe("restore");
    expect(hit.command).toBe("am restore removed");
  });

  test("--limit caps the number of results", () => {
    for (let i = 0; i < 5; i++) {
      const file = writeTranscript([claudeLine("user", `mango number ${i}`)]);
      writeAgent(agent(`m${i}`, file));
    }
    expect(search("mango", { limit: 2 })).toHaveLength(2);
  });

  test("no matches returns an empty list", () => {
    const file = writeTranscript([claudeLine("user", "nothing to see here")]);
    writeAgent(agent("quiet", file));
    expect(search("zzzznope")).toHaveLength(0);
  });
});

// localAgentMatches feeds the picker's `/` chat-search: only locally-registered
// agents (selectable rows) survive, in rank order, each with its lead snippet.
describe("localAgentMatches", () => {
  function result(extra: Partial<SearchResult>): SearchResult {
    return {
      provider: "claude",
      scope: "agent",
      action: "resume",
      command: "am resume x",
      matchCount: 1,
      snippets: [],
      updatedAt: 0,
      ...extra,
    };
  }

  test("keeps local registered agents in order with their lead snippet", () => {
    const { order, snippets } = localAgentMatches([
      result({ agentName: "alpha", snippets: [{ kind: "user", text: "a-snip", matchStart: 0, matchLen: 1 }] }),
      result({ agentName: "beta", snippets: [{ kind: "assistant", text: "b-snip", matchStart: 0, matchLen: 1 }] }),
    ]);
    expect(order).toEqual(["alpha", "beta"]);
    expect(snippets.get("alpha")).toBe("a-snip");
    expect(snippets.get("beta")).toBe("b-snip");
  });

  test("drops remote, history, and duplicate hits", () => {
    const { order } = localAgentMatches([
      result({ agentName: "remote", host: "server" }),
      result({ agentName: "old", scope: "history", action: "adopt" }),
      result({ agentName: "trashed", scope: "trash", action: "restore" }),
      result({ agentName: "live" }),
      result({ agentName: "live" }), // duplicate
    ]);
    expect(order).toEqual(["live"]);
  });
});

describe("search --all (history)", () => {
  let fakeHome: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-search-"));
    fakeHome = mkdtempSync(join(tmpdir(), "am-home-"));
    process.env.AGENTMGR_HOME = home;
    prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    process.env.CODEX_HOME = join(fakeHome, ".codex");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
    delete process.env.CODEX_HOME;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  test("an unregistered session is adoptable via `am new --resume <id>`", () => {
    const sid = "7fea3367-cbd4-48a8-abf3-e692af270edb";
    const projectDir = join(fakeHome, ".claude", "projects", "-tmp-old");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sid}.jsonl`), claudeLine("user", "the lychee migration plan") + "\n");

    expect(search("lychee")).toHaveLength(0); // not in registered scope
    const hit = search("lychee", { all: true })[0]!;
    expect(hit.scope).toBe("history");
    expect(hit.action).toBe("adopt");
    expect(hit.sessionId).toBe(sid);
    expect(hit.command).toContain(`--resume ${sid}`);
  });
});
