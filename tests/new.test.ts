import { describe, expect, test } from "bun:test";
import { agentSystemPrompt, conversationArgs, scrubNestedSessionEnv } from "../src/commands/new";

describe("agentSystemPrompt", () => {
  test("names the agent and teaches the am command surface", () => {
    const prompt = agentSystemPrompt("worker-1");
    expect(prompt).toContain('"worker-1"');
    expect(prompt).toContain("am new");
    expect(prompt).toContain("am ls --json");
    expect(prompt).toContain("trust prompt");
  });
});
import { clipLine } from "../src/picker";

describe("clipLine", () => {
  test("passes short lines through and clips long ones with an ellipsis", () => {
    expect(clipLine("short", 10)).toBe("short");
    expect(clipLine("exactly-10", 10)).toBe("exactly-10");
    expect(clipLine("definitely too long", 10)).toBe("definitel…");
  });
});

describe("conversationArgs", () => {
  const base = {};

  test("defaults to a fresh conversation", () => {
    expect(conversationArgs(base)).toEqual([]);
  });

  test("--resume with an id and --continue map through", () => {
    expect(conversationArgs({ ...base, resume: "abc-123" })).toEqual(["--resume", "abc-123"]);
    expect(conversationArgs({ ...base, continue: true })).toEqual(["--continue"]);
  });

  test("bare --resume opens the picker, but not with -m", () => {
    expect(conversationArgs({ ...base, resume: true })).toEqual(["--resume"]);
    expect(() => conversationArgs({ ...base, resume: true, message: "hi" })).toThrow(/session id/);
  });

  test("--resume and --continue conflict", () => {
    expect(() => conversationArgs({ ...base, resume: "abc", continue: true })).toThrow(/mutually exclusive/);
  });
});

describe("remoteControlArgs", () => {
  test("explicit override wins; otherwise config default (on) applies", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { remoteControlArgs } = await import("../src/commands/new");
    const { configFile } = await import("../src/paths");

    const home = mkdtempSync(join(tmpdir(), "am-test-"));
    process.env.AGENTMGR_HOME = home;
    try {
      expect(remoteControlArgs(undefined)).toEqual(["--remote-control"]); // config default
      expect(remoteControlArgs(false)).toEqual([]); // --no-remote
      writeFileSync(configFile(), JSON.stringify({ remoteControl: false }));
      expect(remoteControlArgs(undefined)).toEqual([]);
      expect(remoteControlArgs(true)).toEqual(["--remote-control"]); // --remote beats config
    } finally {
      rmSync(home, { recursive: true, force: true });
      delete process.env.AGENTMGR_HOME;
    }
  });
});

describe("scrubNestedSessionEnv", () => {
  test("wraps the command in env -u for the CLAUDE_CODE_* family", () => {
    const wrapped = scrubNestedSessionEnv(["claude", "--settings", "/x.json"]);
    expect(wrapped[0]).toBe("env");
    expect(wrapped.slice(-3)).toEqual(["claude", "--settings", "/x.json"]);

    const unset = wrapped.filter((_, i) => wrapped[i - 1] === "-u");
    expect(unset).toContain("CLAUDECODE");
    expect(unset).toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(unset).toContain("CLAUDE_CODE_SESSION_ID");
  });

  test("picks up extra CLAUDE_CODE_ vars from the current environment", () => {
    process.env.CLAUDE_CODE_TEST_EXTRA = "1";
    try {
      const wrapped = scrubNestedSessionEnv(["claude"]);
      expect(wrapped).toContain("CLAUDE_CODE_TEST_EXTRA");
    } finally {
      delete process.env.CLAUDE_CODE_TEST_EXTRA;
    }
  });
});

describe("wrapText", () => {
  test("wraps words, respects newlines, caps lines", async () => {
    const { wrapText } = await import("../src/picker");
    expect(wrapText("a bb ccc", 5, 6)).toEqual(["a bb", "ccc"]);
    expect(wrapText("one\ntwo", 10, 6)).toEqual(["one", "two"]);
    expect(wrapText("aaaaaaaaaa", 4, 6)).toEqual(["aaaa", "aaaa", "aa"]);
    const capped = wrapText("w ".repeat(40), 4, 3);
    expect(capped).toHaveLength(3);
    expect(capped[2]).toBe("…");
  });
});

describe("visibleItems", () => {
  test("secondary items hide by default, show with a-toggle or an active filter", async () => {
    const { visibleItems } = await import("../src/picker");
    const items = [
      { name: "alive", label: "" },
      { name: "gone", label: "", secondary: true },
    ];
    expect(visibleItems(items, "", false).map((i) => i.name)).toEqual(["alive"]);
    expect(visibleItems(items, "", true).map((i) => i.name)).toEqual(["alive", "gone"]);
    expect(visibleItems(items, "gon", false).map((i) => i.name)).toEqual(["gone"]);
  });
});

describe("splitKeys mouse sequences", () => {
  test("SGR mouse reports stay whole and don't shed hotkey chars", async () => {
    const { splitKeys } = await import("../src/picker");
    expect(splitKeys("\x1b[<64;5;3M")).toEqual(["\x1b[<64;5;3M"]);
    expect(splitKeys("\x1b[<0;12;4M\x1b[<0;12;4m")).toEqual(["\x1b[<0;12;4M", "\x1b[<0;12;4m"]);
    // regular keys around a mouse event survive
    expect(splitKeys("j\x1b[<65;1;1Mk")).toEqual(["j", "\x1b[<65;1;1M", "k"]);
  });
});
