import { describe, expect, test } from "bun:test";
import { buildInboxOutput, buildStopGate, formatInbox, hookEffects, shortTask } from "../src/commands/hook";

describe("hookEffects", () => {
  test("maps lifecycle events to statuses", () => {
    expect(hookEffects("session-start", {})).toMatchObject({ status: "idle", drainQueue: true });
    expect(hookEffects("user-prompt-submit", {}).status).toBe("working");
    expect(hookEffects("session-end", {}).status).toBe("exited");
  });

  test("tool events mark working — clears stale needs-attention after approval", () => {
    expect(hookEffects("pre-tool-use", {}).status).toBe("working");
    expect(hookEffects("post-tool-use", {}).status).toBe("working");
    expect(hookEffects("pre-tool-use", {}).notify).toBeUndefined();
    expect(hookEffects("post-tool-use", {}).drainQueue).toBeUndefined();
  });

  test("stop goes idle and drains the queue", () => {
    expect(hookEffects("stop", {})).toMatchObject({ status: "idle", drainQueue: true });
  });

  test("permission notifications flag needs-attention with a message", () => {
    const effects = hookEffects("notification", {
      message: "Claude needs your permission to use Bash",
    });
    expect(effects.status).toBe("needs-attention");
    expect(effects.notify).toContain("permission");
  });

  test("idle-timeout notification stays idle and does not notify", () => {
    const effects = hookEffects("notification", {
      message: "Claude is waiting for your input",
    });
    expect(effects.status).toBe("idle");
    expect(effects.notify).toBeUndefined();
  });

  test("codex permission-request flags needs-attention with the tool name", () => {
    expect(hookEffects("permission-request", { tool_name: "shell" })).toMatchObject({
      status: "needs-attention",
      notify: "approval requested — shell",
    });
    expect(hookEffects("permission-request", {}).notify).toBe("approval requested");
  });

  test("unknown event throws", () => {
    expect(() => hookEffects("nope", {})).toThrow(/unknown hook event/);
  });
});

describe("inbox surfacing (UserPromptSubmit)", () => {
  test("formatInbox singular vs plural, includes the messages", () => {
    const one = formatInbox(["[am · from api] ping"]);
    expect(one).toContain("1 message from another agent");
    expect(one).toContain("[am · from api] ping");
    const two = formatInbox(["[am · from api] a", "[am · from lead] b"]);
    expect(two).toContain("2 messages from other agents");
    expect(two).toContain("[am · from lead] b");
  });

  test("buildInboxOutput: null when empty, additionalContext tagged for the given event", () => {
    expect(buildInboxOutput([], "UserPromptSubmit")).toBeNull();
    const ups = JSON.parse(buildInboxOutput(["[am · from api] hi"], "UserPromptSubmit")!);
    expect(ups.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(ups.hookSpecificOutput.additionalContext).toContain("[am · from api] hi");
    // mid-turn surfacing reuses the same path, tagged for PostToolUse
    const ptu = JSON.parse(buildInboxOutput(["[am · from lead] go"], "PostToolUse")!);
    expect(ptu.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(ptu.hookSpecificOutput.additionalContext).toContain("[am · from lead] go");
  });
});

describe("stop gate (Stop hook block)", () => {
  test("null when empty; blocks with a reason carrying the messages otherwise", () => {
    expect(buildStopGate([])).toBeNull();
    const out = JSON.parse(buildStopGate(["[am · from api] ship it"])!);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("1 message from another agent");
    expect(out.reason).toContain("[am · from api] ship it");
    const two = JSON.parse(buildStopGate(["a", "b"])!);
    expect(two.reason).toContain("2 messages from other agents");
  });
});

describe("shortTask (backstop terseness)", () => {
  test("empty for no task; first line only; capped with ellipsis", () => {
    expect(shortTask(undefined)).toBe("");
    expect(shortTask("short task")).toBe("short task");
    expect(shortTask("first line\nsecond line\nthird")).toBe("first line");
    const long = "x".repeat(200);
    expect(shortTask(long).length).toBe(72);
    expect(shortTask(long).endsWith("…")).toBe(true);
  });
});
