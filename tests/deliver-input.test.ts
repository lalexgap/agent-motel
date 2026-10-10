import { describe, expect, test } from "bun:test";
import { enterDelayMs, inputBoxText, looksUnsubmitted, parsedInputBoxText } from "../src/deliver";
import type { AgentState } from "../src/state";

// Composer/footer lines captured from running Codex and Claude sessions.
const codex = (input: string) => [
  "• Working (4m 46s • esc to interrupt)",
  "  └ Tip: Use /export to save your conversation as Markdown.",
  "",
  "",
  `› ${input}`,
  "",
  "  GPT-6.1-Sol medium · ~/.agent-manager/worktrees/agent-manager/am-t…",
  "  ? for shortcuts                          ⚠ 4 warnings · f2 to view",
];
const claude = (input: string) => [
  "✻ Brewed for 11s · done 10:52 AM",
  "                               new task? /clear to save 224k tokens",
  "─────────────────────────────────────────────────────────────────────",
  `❯ ${input}`,
  "─────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
];

describe("provider composer captures", () => {
  test("Codex placeholder and empty composer are empty", () => {
    expect(parsedInputBoxText(codex("Ask Codex to do anything"), "codex")).toBe("");
    expect(parsedInputBoxText(codex(""), "codex")).toBe("");
  });

  test("Codex human draft includes multiline continuation", () => {
    const pane = codex("check the changes");
    pane.splice(5, 0, "  then run tests", "", "  report what failed");
    expect(inputBoxText(pane, "codex")).toBe("check the changes then run tests report what failed");
    expect(looksUnsubmitted(pane, "check the changes\nthen run tests", "codex")).toBe(true);
  });

  test("Codex submitted transcript text is outside the composer", () => {
    const pane = ["› check the changes", "• Working", ...codex("Ask Codex to do anything")];
    expect(looksUnsubmitted(pane, "check the changes", "codex")).toBe(false);
  });

  test("Codex scrolled composer is recognized without the shortcuts row", () => {
    const pane = [
      "› earlier transcript message",
      "",
      "› - Test item 8: abcdefghij abcdefghij        ↑",
      "  abcdefghij",
      "",
      "  - Test item 9: remaining test data",
      "",
      "  GPT-6.1-Sol medium · /tmp/project",
      "                          ⚠ 4 warnings · f2 to view",
    ];
    const message = "Delivery header\n\n- Test item 8: abcdefghij abcdefghij abcdefghij\n\n- Test item 9: remaining test data";
    expect(parsedInputBoxText(pane, "codex")).toBe("- Test item 8: abcdefghij abcdefghij abcdefghij - Test item 9: remaining test data");
    expect(looksUnsubmitted(pane, message, "codex")).toBe(true);
    expect(looksUnsubmitted(pane, "different message", "codex")).toBe(false);
  });

  test("Codex delay scales with message size and line count, with a cap", () => {
    const agent = { provider: "codex" } as AgentState;
    expect(enterDelayMs(agent, "short")).toBeGreaterThan(150);
    expect(enterDelayMs(agent, "x".repeat(1500))).toBeGreaterThan(enterDelayMs(agent, "short")!);
    expect(enterDelayMs(agent, "a\n\nb")).toBeGreaterThan(enterDelayMs(agent, "a  b")!);
    expect(enterDelayMs(agent, "x\n".repeat(10000))).toBe(2000);
    expect(enterDelayMs({ provider: "claude" } as AgentState, "short")).toBeUndefined();
    expect(enterDelayMs({ provider: "claude" } as AgentState, "a\nb")).toBe(200);
  });

  test("Claude empty, placeholder, draft and submitted states", () => {
    expect(parsedInputBoxText(claude("\u00a0"), "claude")).toBe("");
    expect(inputBoxText(claude('Try "fix lint errors"'), "claude")).toBe("");
    expect(inputBoxText(claude("human draft"), "claude")).toBe("human draft");
    expect(looksUnsubmitted(claude("message"), "message", "claude")).toBe(true);
    expect(looksUnsubmitted(["❯ message", ...claude("")], "message", "claude")).toBe(false);
  });

  test("unknown and incomplete layouts remain unverified", () => {
    expect(parsedInputBoxText(["› draft", "no footer"], "codex")).toBeNull();
    expect(parsedInputBoxText(["  GPT-6.1-Sol medium · ~/project", "  ? for shortcuts"], "codex")).toBeNull();
    expect(parsedInputBoxText(["❯ draft"], "claude")).toBeNull();
    expect(parsedInputBoxText(codex(""), "claude")).toBeNull();
  });
});
