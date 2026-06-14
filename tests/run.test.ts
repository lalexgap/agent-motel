import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalAssistantText } from "../src/commands/run";
import { agentSystemPrompt } from "../src/commands/new";
import type { AgentState } from "../src/state";

function agentWithTranscript(lines: object[]): AgentState {
  const dir = mkdtempSync(join(tmpdir(), "am-run-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const now = new Date().toISOString();
  return {
    name: "t", status: "idle", dir, tmuxSession: "agentmgr-t",
    provider: "claude", transcriptPath: path, createdAt: now, updatedAt: now,
  };
}

describe("finalAssistantText", () => {
  test("returns the last non-empty assistant message", () => {
    const agent = agentWithTranscript([
      { type: "user", message: { content: [{ type: "text", text: "do the thing" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } },
    ]);
    expect(finalAssistantText(agent)).toBe("PONG");
  });

  test("skips trailing tool turns to find the last spoken answer", () => {
    const agent = agentWithTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "here is the result" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } },
    ]);
    expect(finalAssistantText(agent)).toBe("here is the result");
  });

  test("returns empty string when the transcript can't be located", () => {
    const now = new Date().toISOString();
    const agent: AgentState = {
      name: "t", status: "idle", dir: "/nope", tmuxSession: "agentmgr-t",
      transcriptPath: "/nonexistent/session.jsonl", createdAt: now, updatedAt: now,
    };
    expect(finalAssistantText(agent)).toBe("");
  });
});

describe("agentSystemPrompt teaches am run", () => {
  test("the spawn-wait-collect primitive is in the injected guidance", () => {
    const prompt = agentSystemPrompt("worker-1");
    expect(prompt).toContain("am run");
    expect(prompt).toContain("spawn-wait-collect");
    // The decision hinge: am run vs the built-in Task tool.
    expect(prompt).toContain("replacement for the Task tool");
  });
});
