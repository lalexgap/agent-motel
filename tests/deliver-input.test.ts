import { describe, expect, test } from "bun:test";
import { inputBoxText, looksUnsubmitted, parsedInputBoxText } from "../src/deliver";

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
