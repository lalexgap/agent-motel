import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyResumeOverrides, preferenceNote } from "../src/commands/resume";
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
    expect(applyResumeOverrides(a, { preferSubagents: true })).toBeNull();
    expect(a.preferSubagents).toBe(true);
  });

  test("--no-prefer-subagents turns it back off rather than clearing it", () => {
    const a = agent({ preferSubagents: true });
    applyResumeOverrides(a, { preferSubagents: false });
    expect(a.preferSubagents).toBe(false);
  });

  test("a plain resume leaves the stored preference alone", () => {
    const a = agent({ preferSubagents: true });
    expect(applyResumeOverrides(a, { message: "carry on" })).toBeNull();
    expect(a.preferSubagents).toBe(true);
  });

  test("the resumed claude session is primed with the new preference", () => {
    const a = agent();
    applyResumeOverrides(a, { preferSubagents: true });
    const plan = buildResumeCommand("claude", a, {});
    const prompt = plan.command[plan.command.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("prefer your own built-in subagents");
  });
});

describe("preferenceNote", () => {
  test("codex is told the stored change can't reach this session", () => {
    const note = preferenceNote("codex", true)!;
    expect(note).toContain("prefer its own subagents");
    expect(note).toContain("can't be re-primed on resume");
    expect(preferenceNote("codex", false)).toContain("prefer am agents");
  });

  test("claude rebuilds its primer, so there is nothing to warn about", () => {
    expect(preferenceNote("claude", true)).toBeNull();
    expect(preferenceNote("codex", undefined)).toBeNull();
  });
});
