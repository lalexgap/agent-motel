import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tmux from "../src/tmux";
import * as daemon from "../src/daemon";
import { reviveAgent } from "../src/commands/resume";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { queueAppend, queueList } from "../src/queue";
import { readSubagents, recordSubagentStart } from "../src/subagents";

let testDir: string;
let agent: AgentState;
let live: boolean;
let launched: Parameters<typeof tmux.newSession>[0] | undefined;
let restores: (() => void)[];

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "am-restart-test-"));
  process.env.AGENTMGR_HOME = testDir;
  const now = new Date().toISOString();
  agent = {
    name: "test-restart", dir: testDir, tmuxSession: "agentmgr-test-restart",
    provider: "claude", claudeSessionId: "saved-conversation", status: "working",
    createdAt: now, updatedAt: now,
  };
  writeAgent(agent);
  live = true;
  launched = undefined;
  const hasSession = spyOn(tmux, "hasSession").mockImplementation(() => live);
  const killSession = spyOn(tmux, "killSession").mockImplementation(() => { live = false; });
  const newSession = spyOn(tmux, "newSession").mockImplementation((opts) => {
    expect(live).toBe(false);
    launched = opts;
    live = true;
  });
  const ensureDaemon = spyOn(daemon, "ensureDaemon").mockResolvedValue(true);
  restores = [hasSession, killSession, newSession, ensureDaemon].map((mock) => () => mock.mockRestore());
});

afterEach(() => {
  for (const restore of restores) restore();
  delete process.env.AGENTMGR_HOME;
  rmSync(testDir, { recursive: true, force: true });
});

describe("restart", () => {
  test("relaunches the saved conversation and preserves queued work", async () => {
    queueAppend(agent.name, "follow up");
    recordSubagentStart(agent.name, { id: "native-child", type: "Explore" });
    await reviveAgent(agent, { restart: true });
    expect(launched?.session).toBe(agent.tmuxSession);
    expect(launched?.dir).toBe(testDir);
    expect(launched?.command).toContain("--resume");
    expect(launched?.command).toContain("saved-conversation");
    expect(readAgent(agent.name)?.status).toBe("starting");
    expect(queueList(agent.name).map((entry) => entry.message)).toEqual(["follow up"]);
    expect(readSubagents(agent.name)[0]?.endedAt).toBeTruthy();
  });

  test("checks the directory before stopping a running agent", async () => {
    agent.dir = join(testDir, "missing");
    await expect(reviveAgent(agent, { restart: true })).rejects.toThrow("directory no longer exists");
    expect(live).toBe(true);
    expect(launched).toBeUndefined();
  });

  test("also relaunches stopped agents", async () => {
    live = false;
    await reviveAgent(agent, { restart: true });
    expect(launched?.command).toContain("saved-conversation");
  });

  test("ordinary revive leaves a running agent alone", async () => {
    await reviveAgent(agent);
    expect(live).toBe(true);
    expect(launched).toBeUndefined();
  });
});
