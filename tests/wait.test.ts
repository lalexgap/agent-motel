import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusMatches, waitForStatus } from "../src/commands/wait";
import { formatPeek } from "../src/commands/peek";
import { waitForTurn } from "../src/commands/run";
import { queueAppend } from "../src/queue";
import { writeAgent, type AgentState } from "../src/state";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-wait-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function makeAgent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return {
    name,
    status: "exited",
    dir: home,
    // No such tmux session: a non-exited status displays as "dead".
    tmuxSession: `agentmgr-wait-test-${name}`,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("waitForStatus", () => {
  test("resolves immediately when the status already matches", async () => {
    writeAgent(makeAgent("a", { status: "exited" }));
    expect(await waitForStatus("a", "exited", 5000)).toBe("reached");
  });

  test("display status is what's matched — a sessionless 'working' agent is dead", async () => {
    writeAgent(makeAgent("a", { status: "working" }));
    expect(await waitForStatus("a", "dead", 5000)).toBe("reached");
  });

  test("times out when the status never arrives", async () => {
    writeAgent(makeAgent("a", { status: "exited" }));
    expect(await waitForStatus("a", "working", 100)).toBe("timeout");
  });

  test("reports a removed agent instead of spinning", async () => {
    expect(await waitForStatus("never-existed", "idle", 5000)).toBe("removed");
  });

  test("waiting satisfies a request for idle (it IS idle underneath)", () => {
    expect(statusMatches("waiting", "idle")).toBe(true);
    expect(statusMatches("idle", "waiting")).toBe(false);
    expect(statusMatches("working", "idle")).toBe(false);
  });
});

describe("waitForTurn on pre-existing agents", () => {
  test("a dead session fails fast as exited instead of spinning to timeout", async () => {
    // State frozen at "working" but the tmux session is gone (reboot/kill):
    // no hook will ever move it, so the wait must not burn the full timeout.
    writeAgent(makeAgent("a", { status: "working" }));
    const start = Date.now();
    expect(await waitForTurn("a", 60_000)).toBe("exited");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("a removed agent reads as exited", async () => {
    expect(await waitForTurn("never-existed", 1000)).toBe("exited");
  });

  test("a queued message means the turn hasn't begun — no premature done", async () => {
    writeAgent(makeAgent("a", { status: "exited" }));
    // exited short-circuits regardless of queue: sanity for the terminal branch
    queueAppend("a", "pending");
    expect(await waitForTurn("a", 1000)).toBe("exited");
  });
});

describe("formatPeek", () => {
  const colored = ["\x1b[32mgreen\x1b[0m line", "plain line", "last line"];

  test("keeps colors for a terminal, strips them for a pipe", () => {
    expect(formatPeek(colored, { colors: true })).toContain("\x1b[32m");
    const plain = formatPeek(colored, { colors: false });
    expect(plain).not.toContain("\x1b[");
    expect(plain).toBe("green line\nplain line\nlast line");
  });

  test("--lines tails the output", () => {
    expect(formatPeek(colored, { lines: 2, colors: false })).toBe("plain line\nlast line");
    // Zero/absent = everything.
    expect(formatPeek(colored, { lines: 0, colors: false }).split("\n")).toHaveLength(3);
  });
});

describe("readFileTail", () => {
  test("drops the torn first line on a truncated read; whole file otherwise", async () => {
    const { readFileTail } = await import("../src/fsutil");
    const { writeFileSync } = await import("node:fs");
    const file = join(home, "tail.jsonl");
    writeFileSync(file, "first line\nsecond line\nthird line\n");

    expect(readFileTail(file, 1024)).toBe("first line\nsecond line\nthird line\n");
    // 25 bytes reaches into "second line" — the partial line is dropped.
    expect(readFileTail(file, 23)).toBe("third line\n");
    expect(readFileTail(join(home, "missing"), 100)).toBeNull();
  });
});
