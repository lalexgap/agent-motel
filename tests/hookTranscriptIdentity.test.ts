import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "../src/state";

const CLI = join(import.meta.dir, "../src/index.ts");
let home: string;
let stateFile: string;
let parentPath: string;
let childPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-hook-transcript-"));
  mkdirSync(join(home, "agents"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ idleNotify: false }));
  parentPath = join(home, "parent.jsonl");
  childPath = join(home, "child.jsonl");
  writeFileSync(parentPath, "");
  writeFileSync(childPath, "");
  stateFile = join(home, "agents", "parent.json");
  const agent: AgentState = {
    name: "parent", provider: "codex", codexDaemon: true, codexDaemonAttached: true,
    sessionId: "parent-session", transcriptPath: parentPath,
    status: "needs-attention", statusReason: "approval requested",
    dir: home, tmuxSession: "fixture-parent", createdAt: "now", updatedAt: "now",
  };
  writeFileSync(stateFile, JSON.stringify(agent));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function readAgent(): AgentState {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function hook(event: string, payload: Record<string, unknown>, inherited = false): AgentState {
  const result = Bun.spawnSync([process.execPath, CLI, "hook", event], {
    cwd: home,
    env: {
      HOME: home, CODEX_HOME: join(home, ".codex"), AGENTMGR_HOME: home,
      PATH: join(home, "bin"), AGENTMGR_AGENT: inherited ? "parent" : "",
    },
    stdin: Buffer.from(JSON.stringify({ session_id: "parent-session", ...payload })),
    timeout: 10_000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return readAgent();
}

const ordinaryEvents = ["pre-tool-use", "post-tool-use", "user-prompt-submit", "stop"];

describe("hook transcript source identity", () => {
  for (const event of ordinaryEvents) {
    test(`daemon child ${event} preserves parent source and existing status behavior`, () => {
      // Daemon hooks share the parent's session ID even when the rollout is the child's.
      const agent = hook(event, { agent_id: "child", transcript_path: childPath });
      expect(agent.sessionId).toBe("parent-session");
      expect(agent.transcriptPath).toBe(parentPath);
      expect(agent.status).toBe(event === "stop" ? "idle" : "working");
      expect(agent.statusReason).toBeUndefined();
    });
  }

  for (const event of ["session-start", ...ordinaryEvents]) {
    test(`main ${event} still updates the transcript source`, () => {
      const nextPath = join(home, "next-parent.jsonl");
      const agent = hook(event, { agent_id: "", transcript_path: nextPath });
      expect(agent.sessionId).toBe("parent-session");
      expect(agent.transcriptPath).toBe(nextPath);
      expect(agent.status).toBe(event === "stop" || event === "session-start" ? "idle" : "working");
    });
  }

  for (const event of ["subagent-start", "subagent-stop"]) {
    for (const agentId of ["child", undefined]) {
      test(`${event} preserves parent source with agent_id=${agentId}`, () => {
        const agent = hook(event, { agent_id: agentId, transcript_path: childPath, agent_transcript_path: childPath });
        expect(agent.sessionId).toBe("parent-session");
        expect(agent.transcriptPath).toBe(parentPath);
        expect(agent.status).toBe("working");
      });
    }
  }

  test("inherited child hooks cannot replace session identity, while main hooks can", () => {
    const initial = readAgent();
    writeFileSync(stateFile, JSON.stringify({ ...initial, codexDaemonAttached: false }));
    for (const event of ordinaryEvents) {
      const agent = hook(event, { agent_id: "child", session_id: "child-session", transcript_path: childPath }, true);
      expect(agent.sessionId).toBe("parent-session");
      expect(agent.transcriptPath).toBe(parentPath);
    }
    const agent = hook("user-prompt-submit", { session_id: "next-parent-session", transcript_path: childPath }, true);
    expect(agent.sessionId).toBe("next-parent-session");
    expect(agent.transcriptPath).toBe(childPath);
  });
});
