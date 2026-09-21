import { describe, expect, test } from "bun:test";
import { remoteNewCommandArgs } from "../src/commands/ui";

describe("remote new-agent command", () => {
  test("passes either selected provider explicitly to the remote", () => {
    expect(remoteNewCommandArgs({ name: "claude-agent", provider: "claude" })).toEqual([
      "new",
      "claude-agent",
      "--no-jump",
      "--claude",
    ]);
    expect(remoteNewCommandArgs({ name: "codex-agent", provider: "codex" })).toEqual([
      "new",
      "codex-agent",
      "--no-jump",
      "--codex",
    ]);
  });

  test("passes the form's fan-out choice explicitly, since the remote has its own default", () => {
    expect(remoteNewCommandArgs({ name: "a", preferSubagents: true })).toContain("--prefer-subagents");
    expect(remoteNewCommandArgs({ name: "a", preferSubagents: false })).toContain("--no-prefer-subagents");
  });

  test("leaving it on default sends no flag, so the remote's config decides", () => {
    const args = remoteNewCommandArgs({ name: "a" });
    expect(args.some((a) => a.includes("prefer-subagents"))).toBe(false);
  });
});
