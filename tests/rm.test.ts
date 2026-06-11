import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destroyAgent, stopAgent } from "../src/commands/rm";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { queueAppend, queueDepth } from "../src/queue";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function makeAgent(name: string): AgentState {
  const now = new Date().toISOString();
  const agent: AgentState = {
    name,
    status: "working",
    dir: "/tmp",
    tmuxSession: `agentmgr-test-nonexistent-${name}`,
    createdAt: now,
    updatedAt: now,
  };
  writeAgent(agent);
  return agent;
}

describe("stopAgent", () => {
  test("marks the agent exited but keeps its state", () => {
    const agent = makeAgent("alpha");
    stopAgent(agent);
    expect(readAgent("alpha")?.status).toBe("exited");
  });
});

describe("destroyAgent", () => {
  test("removes state and queue", () => {
    const agent = makeAgent("alpha");
    queueAppend("alpha", "pending");

    destroyAgent(agent, { clean: false });
    expect(readAgent("alpha")).toBeNull();
    expect(queueDepth("alpha")).toBe(0);
  });
});
