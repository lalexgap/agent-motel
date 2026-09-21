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

});
