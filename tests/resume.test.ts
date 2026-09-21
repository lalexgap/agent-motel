import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyResumeOverrides, preferenceEffect } from "../src/commands/resume";
import { buildResumeCommand } from "../src/providers";
import type { AgentState } from "../src/state";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-resume-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    name: "worker",
    status: "exited",
    dir: "/tmp",
    tmuxSession: "agentmgr-worker",
    provider: "claude",
    sessionId: "s-1",
    createdAt: "2026-09-21T10:00:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("applyResumeOverrides", () => {
  test("stores the new fan-out preference", () => {
    const a = agent();
    expect(applyResumeOverrides(a, { preferSubagents: true })).toEqual({});
    expect(a.preferSubagents).toBe(true);
  });

  test("--no-prefer-subagents turns it back off rather than clearing it", () => {
    const a = agent({ preferSubagents: true });
    applyResumeOverrides(a, { preferSubagents: false });
    expect(a.preferSubagents).toBe(false);
  });

  test("a plain resume leaves the stored preference alone", () => {
    const a = agent({ preferSubagents: true });
    expect(applyResumeOverrides(a, { message: "carry on" })).toEqual({});
    expect(a.preferSubagents).toBe(true);
  });

  test("a codex agent is queued the new instruction, since its primer can't change", () => {
    const a = agent({ provider: "codex" });
    const effect = applyResumeOverrides(a, { preferSubagents: true });
    expect(a.preferSubagents).toBe(true);
    expect(effect.message).toContain("Your fan-out preference changed");
  });

  test("the resumed claude session is primed with the new preference", () => {
    const a = agent();
    applyResumeOverrides(a, { preferSubagents: true });
    const plan = buildResumeCommand("claude", a, {});
    const prompt = plan.command[plan.command.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("prefer your own built-in subagents");
  });
});

describe("preferenceEffect", () => {
  test("claude rebuilds its primer, so nothing else is needed", () => {
    expect(preferenceEffect("claude", undefined, true)).toEqual({});
  });

  test("codex gets the new instruction as a message, and is told so", () => {
    const effect = preferenceEffect("codex", undefined, true);
    expect(effect.note).toContain("takes it as a message");
    expect(effect.message).toContain("prefer your own built-in subagents");

    const back = preferenceEffect("codex", undefined, false);
    expect(back.note).toContain("prefer am agents");
    expect(back.message).toContain("Spawn a real am agent when delegating a WHOLE task");
  });

  test("the concierge says the setting can't apply instead of silently ignoring it", () => {
    for (const provider of ["claude", "codex"] as const) {
      const effect = preferenceEffect(provider, "concierge", true);
      expect(effect.note).toContain("role instructions alone");
      expect(effect.message).toBeUndefined();
    }
  });
});
