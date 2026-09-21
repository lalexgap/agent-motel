import { describe, expect, test } from "bun:test";
import { hostname, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentSystemPrompt,
  buildLaunchCommand,
  buildResumeCommand,
  codexConversationArgs,
  CONCIERGE_NAME,
} from "../src/providers";
import type { AgentState } from "../src/state";
import { shortHost } from "../src/config";

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

  test("delegates through built-in subagents and never spawns am agents itself", () => {
    const prompt = agentSystemPrompt("worker");
    expect(prompt).toContain("fan out with your own built-in subagents");
    expect(prompt).toContain("am subagents");
    expect(prompt).toContain("Never spawn another am agent");
    // The operator can still ask for one, and the fleet commands stay.
    expect(prompt).toContain("am new <name>");
    expect(prompt).toContain("am send X");
    // Nothing left of the agents-spawning-agents model.
    expect(prompt).not.toContain("--role engineer");
    expect(prompt).not.toContain("--role reviewer");
    expect(prompt).not.toContain("am run");
  });

  test("a role's instructions still compose after the managed-agent guidance", () => {
    const prompt = agentSystemPrompt("worker", { role: "shepherd", roleInstructions: "Shepherd it." });
    expect(prompt).toContain("# Your role: shepherd");
    expect(prompt).toContain("Shepherd it.");
  });

  test("adds the reporting briefing only when a target is set", () => {
    const prompt = agentSystemPrompt("worker", { reportTo: "lead" });
    expect(prompt).toContain('You are reporting to "lead"');
    expect(prompt).toContain('am send lead');
  });

  test("composes a custom role after the managed-agent guidance", () => {
    const prompt = agentSystemPrompt("worker", {
      role: "security-reviewer",
      roleInstructions: "Inspect trust boundaries and authentication.",
    });
    expect(prompt).toContain("# Your role: security-reviewer");
    expect(prompt).toContain("Inspect trust boundaries and authentication.");
    expect(prompt).toContain("am ls --json");
  });

  test("names the host it runs on and warns about machine-local URLs", () => {
    const home = mkdtempSync(join(tmpdir(), "am-test-"));
    process.env.AGENTMGR_HOME = home;
    try {
      const prompt = agentSystemPrompt("worker");
      expect(prompt).toContain(`You are running on the host "${shortHost(hostname())}"`);
      expect(prompt).toContain("ph.test");
      expect(prompt).toContain("ssh -L");
    } finally {
      delete process.env.AGENTMGR_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prefers the configured hostAlias as the host identity", () => {
    const home = mkdtempSync(join(tmpdir(), "am-test-"));
    process.env.AGENTMGR_HOME = home;
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ hostAlias: "gapserver" }));
      const prompt = agentSystemPrompt("worker");
      expect(prompt).toContain('You are running on the host "gapserver"');
      expect(prompt).toContain("only resolve ON gapserver");
    } finally {
      delete process.env.AGENTMGR_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the reserved concierge name selects the fleet-management prompt", () => {
    const prompt = agentSystemPrompt(CONCIERGE_NAME);
    expect(prompt).toContain("concierge");
    expect(prompt).toContain("not a coding agent");
    // Teaches the discovery surface…
    expect(prompt).toContain("am summary");
    expect(prompt).toContain("am search");
    expect(prompt).toContain("am transcript");
    expect(prompt).toContain("am peek");
    // …and the confirmation boundary for destructive actions.
    expect(prompt).toContain("explicitly asked");
    expect(prompt).toContain("--clean");
    // The generic managed-agent naming/spawning guidance is replaced wholesale.
    expect(prompt).not.toContain("<project>-<scope>[-<role>]");
  });

  test("resuming the concierge re-applies the concierge prompt", () => {
    const plan = buildResumeCommand(
      "claude",
      agent({ name: CONCIERGE_NAME, sessionId: "id-9", tmuxSession: `agentmgr-${CONCIERGE_NAME}` }),
      { remote: false },
    );
    const idx = plan.command.indexOf("--append-system-prompt");
    expect(plan.command[idx + 1]).toContain("front desk");
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

  test("claude gets its Workflow tool: built-in fan-out is the intended mechanism now", () => {
    const plan = buildLaunchCommand("claude", "worker", { message: "do the thing", remote: false });
    expect(plan.command).not.toContain("--disallowedTools");
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

  test("codex submits a taskless custom role so its instructions take effect", () => {
    const plan = buildLaunchCommand("codex", "worker", {
      role: "reviewer",
      roleInstructions: "Review changes only.",
    });
    expect(plan.command.at(-1)).toContain("# Your role: reviewer");
    expect(plan.command.at(-1)).toContain("Review changes only.");
  });

  test("codex keeps the bare resume selector positional-free and defers its role", () => {
    const plan = buildLaunchCommand("codex", "worker", {
      resume: true,
      role: "reviewer",
      roleInstructions: "Review changes only.",
    });
    expect(plan.command.at(-1)).toBe("resume");
    expect(plan.deferredMessage).toContain("# Your role: reviewer");
    expect(plan.deferredMessage).toContain("Review changes only.");
  });

  test("claude threads --model and --effort when set", () => {
    const plan = buildLaunchCommand("claude", "worker", {
      message: "do the thing",
      remote: false,
      model: "claude-opus-4-8",
      effort: "high",
    });
    const m = plan.command.indexOf("--model");
    expect(m).toBeGreaterThanOrEqual(0);
    expect(plan.command[m + 1]).toBe("claude-opus-4-8");
    const e = plan.command.indexOf("--effort");
    expect(e).toBeGreaterThanOrEqual(0);
    expect(plan.command[e + 1]).toBe("high");
    // The message still lands last (the model/effort flags don't swallow it).
    expect(plan.command.at(-1)).toBe("do the thing");
  });

  test("claude omits --model and --effort when unset", () => {
    const plan = buildLaunchCommand("claude", "worker", { message: "do the thing", remote: false });
    expect(plan.command).not.toContain("--model");
    expect(plan.command).not.toContain("--effort");
  });

  test("codex maps effort onto -c model_reasoning_effort and never uses --effort", () => {
    const plan = buildLaunchCommand("codex", "worker", {
      message: "do the thing",
      model: "gpt-5-codex",
      effort: "low",
    });
    const m = plan.command.indexOf("--model");
    expect(m).toBeGreaterThanOrEqual(0);
    expect(plan.command[m + 1]).toBe("gpt-5-codex");
    // Effort is a -c config override, not a --effort flag (codex has none).
    expect(plan.command).not.toContain("--effort");
    const c = plan.command.indexOf("model_reasoning_effort=low");
    expect(c).toBeGreaterThanOrEqual(0);
    expect(plan.command[c - 1]).toBe("-c");
  });

  test("codex omits model/effort overrides when unset", () => {
    const plan = buildLaunchCommand("codex", "worker", { message: "do the thing" });
    expect(plan.command).not.toContain("--model");
    expect(plan.command).not.toContain("--effort");
    expect(plan.command.some((a) => a.startsWith("model_reasoning_effort="))).toBe(false);
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

  test("claude resume reapplies the snapshotted role instructions", () => {
    const plan = buildResumeCommand("claude", agent({
      sessionId: "id-1",
      role: "reviewer",
      roleInstructions: "Review only; do not implement.",
    }), { remote: false });
    expect(plan.command.join(" ")).toContain("# Your role: reviewer");
    expect(plan.command.join(" ")).toContain("Review only; do not implement.");
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
