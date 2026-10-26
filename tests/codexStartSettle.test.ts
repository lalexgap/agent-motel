import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexReadyAtPrompt } from "../src/deliver";
import { settleCodexStart } from "../src/daemon";
import { readAgent, writeAgent, type AgentState } from "../src/state";

const idlePane = [
  "  Worked for 34s • 2:48 PM",
  "",
  "› Ask Codex to do anything",
  "",
  "  GPT-6-Luna low · ~ · caretaker",
  "  ← for agents · ? for shortcuts                       ⚠ 4 warnings · f2 to view",
];
const runningPane = ["• Working (12s • esc to interrupt)", "", ...idlePane.slice(2)];
const bootingPane = ["╭────────────────────────╮", "│ >_ OpenAI Codex         │", "╰────────────────────────╯"];

describe("codexReadyAtPrompt", () => {
  test("is true at an empty or drafted composer with no turn running", () => {
    expect(codexReadyAtPrompt(idlePane)).toBe(true);
    expect(codexReadyAtPrompt(idlePane.map((line) => line.replace("Ask Codex to do anything", "half-typed")))).toBe(true);
  });
  test("is false while a turn runs or before the composer is drawn", () => {
    expect(codexReadyAtPrompt(runningPane)).toBe(false);
    expect(codexReadyAtPrompt(bootingPane)).toBe(false);
  });
});

describe("settleCodexStart", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-test-"));
    process.env.AGENTMGR_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });
  const agent = (overrides: Partial<AgentState> = {}): AgentState => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const state: AgentState = { name: "caretaker", status: "starting", provider: "codex", dir: "/tmp", tmuxSession: "agentmgr-caretaker",
      createdAt: old, updatedAt: old, statusChangedAt: old, ...overrides };
    writeAgent(state);
    return readAgent(state.name)!;
  };

  test("marks a resumed Codex agent idle once its prompt is on screen", () => {
    expect(settleCodexStart(agent(), () => idlePane)).toBe(true);
    expect(readAgent("caretaker")?.status).toBe("idle");
  });

  test("leaves it alone while booting, running, inside the grace period, or for Claude", () => {
    expect(settleCodexStart(agent(), () => bootingPane)).toBe(false);
    expect(settleCodexStart(agent(), () => runningPane)).toBe(false);
    expect(settleCodexStart(agent({ statusChangedAt: new Date().toISOString() }), () => idlePane)).toBe(false);
    expect(settleCodexStart(agent({ provider: "claude" }), () => idlePane)).toBe(false);
    expect(readAgent("caretaker")?.status).toBe("starting");
  });

  test("leaves a session-less daemon-attached agent starting so its first SessionStart can bind", () => {
    expect(settleCodexStart(agent({ codexDaemonAttached: true }), () => idlePane)).toBe(false);
    expect(readAgent("caretaker")?.status).toBe("starting");
    expect(settleCodexStart(agent({ codexDaemonAttached: true, sessionId: "thread-1" }), () => idlePane)).toBe(true);
  });

  test("does not overwrite a status a hook set after the sweep read the agent", () => {
    const stale = agent();
    writeAgent({ ...readAgent("caretaker")!, status: "working" });
    expect(settleCodexStart(stale, () => idlePane)).toBe(false);
    expect(readAgent("caretaker")?.status).toBe("working");
  });
});
