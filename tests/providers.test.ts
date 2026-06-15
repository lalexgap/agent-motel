import { describe, expect, test } from "bun:test";
import {
  agentSystemPrompt,
  buildLaunchCommand,
  buildResumeCommand,
  codexConversationArgs,
} from "../src/providers";
import type { AgentState } from "../src/state";

describe("codexConversationArgs", () => {
  test("maps resume/continue onto the codex resume subcommand", () => {
    expect(codexConversationArgs({})).toEqual([]);
    expect(codexConversationArgs({ resume: "abc-123" })).toEqual(["resume", "abc-123"]);
    expect(codexConversationArgs({ resume: true })).toEqual(["resume"]);
    expect(codexConversationArgs({ continue: true })).toEqual(["resume", "--last"]);
  });

  test("rejects ambiguous combinations like the claude side", () => {
    expect(() => codexConversationArgs({ resume: "a", continue: true })).toThrow(/mutually exclusive/);
    expect(() => codexConversationArgs({ resume: true, message: "hi" })).toThrow(/session id/);
  });
});

describe("agentSystemPrompt", () => {
  test("always teaches the attribution etiquette", () => {
    const prompt = agentSystemPrompt("worker");
    expect(prompt).toContain("[am · from X]");
    expect(prompt).toContain("am send X");
    expect(prompt).not.toContain("You are reporting to");
  });

  test("adds the reporting briefing only when a target is set", () => {
    const prompt = agentSystemPrompt("worker", { reportTo: "lead" });
    expect(prompt).toContain('You are reporting to "lead"');
    expect(prompt).toContain('am send lead');
  });
});

describe("buildLaunchCommand", () => {
  test("threads reportTo into the claude system prompt", () => {
    const plan = buildLaunchCommand("claude", "worker", { reportTo: "lead", remote: false });
    const idx = plan.command.indexOf("--append-system-prompt");
    expect(plan.command[idx + 1]).toContain('reporting to "lead"');
  });

  test("claude keeps the hook settings file and system prompt flags", () => {
    const plan = buildLaunchCommand("claude", "worker", { message: "do the thing", remote: false });
    expect(plan.command[0]).toBe("claude");
    expect(plan.command).toContain("--settings");
    expect(plan.command).toContain("--append-system-prompt");
    expect(plan.command.at(-1)).toBe("do the thing");
    expect(plan.deferredMessage).toBeUndefined();
  });

  test("claude disables the Workflow tool without swallowing the prompt", () => {
    const plan = buildLaunchCommand("claude", "worker", { message: "do the thing", remote: false });
    const idx = plan.command.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(plan.command[idx + 1]).toBe("Workflow");
    // The variadic <tools...> must be followed by a flag, never the message
    // positional — otherwise the prompt becomes a second "tool" and is lost.
    expect(plan.command[idx + 2]!.startsWith("--")).toBe(true);
    expect(plan.command.at(-1)).toBe("do the thing");
  });

  test("codex gets no --disallowedTools (it has no Workflow tool)", () => {
    const plan = buildLaunchCommand("codex", "worker", { message: "do the thing", remote: false });
    expect(plan.command).not.toContain("--disallowedTools");
  });

  test("claude launches permissionless by default", () => {
    const plan = buildLaunchCommand("claude", "worker", { message: "do the thing", remote: false });
    expect(plan.command).toContain("--dangerously-skip-permissions");
  });

  test("codex launches permissionless by default (its bypass flag, before the -c overrides)", () => {
    const plan = buildLaunchCommand("codex", "worker", { message: "do the thing", remote: false });
    expect(plan.command).toContain("--dangerously-bypass-approvals-and-sandbox");
    // claude's flag must not leak onto codex.
    expect(plan.command).not.toContain("--dangerously-skip-permissions");
  });

  test("claude with remote control defers the message and puts the flag last", () => {
    const plan = buildLaunchCommand("claude", "worker", { message: "do the thing", remote: true });
    // --remote-control swallows a trailing positional, so the message must
    // not be on the command line at all.
    expect(plan.command.at(-1)).toBe("--remote-control");
    expect(plan.command).not.toContain("do the thing");
    expect(plan.deferredMessage).toBe("do the thing");
  });

  test("codex suppresses the update prompt and rides the preamble in the prompt", () => {
    const plan = buildLaunchCommand("codex", "worker", { message: "do the thing", remote: true });
    expect(plan.command[0]).toBe("codex");
    expect(plan.command).toContain("check_for_update_on_startup=false");
    // No system-prompt flag exists; the managed-agent preamble is prepended
    // to the initial prompt instead. Remote control is claude-only.
    expect(plan.command).not.toContain("--append-system-prompt");
    expect(plan.command).not.toContain("--remote-control");
    expect(plan.command.at(-1)).toContain('"worker"');
    expect(plan.command.at(-1)).toContain("do the thing");
    expect(plan.deferredMessage).toBeUndefined();
  });

  test("codex without a message submits no prompt at all", () => {
    const plan = buildLaunchCommand("codex", "worker", {});
    expect(plan.command.at(-1)).toBe("check_for_update_on_startup=false");
  });
});

function agent(overrides: Partial<AgentState>): AgentState {
  return {
    name: "a",
    status: "exited",
    dir: "/tmp",
    tmuxSession: "agentmgr-a",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildResumeCommand", () => {
  test("codex resumes by session id, falling back to --last", () => {
    expect(buildResumeCommand("codex", agent({ sessionId: "id-1" }), {}).command).toEqual([
      "codex", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false", "resume", "id-1",
    ]);
    expect(buildResumeCommand("codex", agent({}), {}).command).toContain("--last");
  });

  test("claude reads the legacy claudeSessionId field", () => {
    const plan = buildResumeCommand("claude", agent({ claudeSessionId: "legacy-id" }), { remote: false });
    expect(plan.command).toContain("--resume");
    expect(plan.command).toContain("legacy-id");
  });

  test("claude resume with remote control defers the message", () => {
    const plan = buildResumeCommand("claude", agent({ sessionId: "id-1" }), {
      message: "keep going",
      remote: true,
    });
    expect(plan.command.at(-1)).toBe("--remote-control");
    expect(plan.deferredMessage).toBe("keep going");
  });
});
