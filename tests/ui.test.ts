import { paneTitleSequence, tmuxPaneTitle } from "../src/paneTitle";
import { describe, expect, test } from "bun:test";
import { hubPaneTitle, remoteNewCommandArgs } from "../src/commands/ui";

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

describe("focused hub pane titles", () => {
  test("preserves local, remote and subagent identity and resets empty rows", () => {
    expect(hubPaneTitle("local-agent")).toBe("local-agent");
    expect(hubPaneTitle("fixture.example:remote-agent")).toBe("remote-agent@fixture");
    expect(hubPaneTitle("local-agent⤷123456789abc")).toBe("local-agent ⤷ 12345678");
    expect(hubPaneTitle("fixture.example:remote-agent⤷123456789abc")).toBe("remote-agent@fixture ⤷ 12345678");
    expect(hubPaneTitle(null)).toBe("am");
    expect(hubPaneTitle("fixture:")).toBe("am");
  });

  test("keeps names literal and removes terminal control characters", () => {
    expect(paneTitleSequence("a\x07\x1b]52;c;payload\x9cb\n")).toBe("\x1b]2;a]52;c;payloadb\x07");
    expect(paneTitleSequence("#{pane_title}; '$()' \\" )).toBe("\x1b]2;#{pane_title}; '$()' \\\x07");
    expect(tmuxPaneTitle("literal #{session_name}; $(ignored)\x07")).toBe("literal ##{session_name}; $(ignored)");
    expect(paneTitleSequence("\x00\x1b\x7f\x9f")).toBe("\x1b]2;am\x07");
  });
});
