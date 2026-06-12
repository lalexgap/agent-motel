import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultMoveTarget,
  dirtyGitFiles,
  importPayload,
  mapHomeDir,
  parseMoveSpec,
  targetTranscriptPath,
} from "../src/commands/move";
import { fleetKey, splitFleetKey, shortHost } from "../src/fleet";
import { readAgent, type AgentState } from "../src/state";
import { queueList } from "../src/queue";

describe("mapHomeDir", () => {
  test("swaps the home prefix", () => {
    expect(mapHomeDir("/Users/lagap/code/x", "/Users/lagap", "/home/lagap")).toBe("/home/lagap/code/x");
    expect(mapHomeDir("/home/lagap", "/home/lagap", "/Users/lagap")).toBe("/Users/lagap");
  });

  test("returns null outside home (and for lookalike prefixes)", () => {
    expect(mapHomeDir("/tmp/x", "/Users/lagap", "/home/lagap")).toBeNull();
    expect(mapHomeDir("/Users/lagap2/code", "/Users/lagap", "/home/lagap")).toBeNull();
  });
});

describe("parseMoveSpec", () => {
  test("push and pull forms", () => {
    expect(parseMoveSpec("demo", "server")).toEqual({ direction: "push", host: "server", name: "demo" });
    expect(parseMoveSpec("server:demo", undefined)).toEqual({ direction: "pull", host: "server", name: "demo" });
  });

  test("rejects malformed forms", () => {
    expect(() => parseMoveSpec("demo", undefined)).toThrow(/usage/);
    expect(() => parseMoveSpec("server:demo", "other")).toThrow(/no second argument/);
  });
});

describe("targetTranscriptPath", () => {
  test("claude: slug of the TARGET dir", () => {
    expect(targetTranscriptPath("claude", "/home/lagap", "/home/lagap/code/x", "abc-123", null)).toBe(
      "/home/lagap/.claude/projects/-home-lagap-code-x/abc-123.jsonl",
    );
  });

  test("codex: rollout relative path mirrored under target ~/.codex", () => {
    expect(
      targetTranscriptPath("codex", "/home/lagap", "/home/lagap/code/x", "abc", "sessions/2026/06/12/rollout-abc.jsonl"),
    ).toBe("/home/lagap/.codex/sessions/2026/06/12/rollout-abc.jsonl");
    expect(() => targetTranscriptPath("codex", "/h", "/h/x", "abc", null)).toThrow(/rollout/);
  });
});

describe("defaultMoveTarget", () => {
  test("remote rows pull home; local rows push to the single remote", () => {
    expect(defaultMoveTarget("home.alexgap.ca:demo", ["home.alexgap.ca"])).toMatchObject({
      first: "home.alexgap.ca:demo",
    });
    expect(defaultMoveTarget("demo", ["home.alexgap.ca"])).toMatchObject({
      first: "demo",
      second: "home.alexgap.ca",
    });
  });

  test("zero or many remotes yield guidance", () => {
    expect(defaultMoveTarget("demo", [])).toMatchObject({ error: expect.stringContaining("no remotes") });
    expect(defaultMoveTarget("demo", ["a", "b"])).toMatchObject({ error: expect.stringContaining("multiple") });
  });
});

describe("fleet keys", () => {
  test("round-trip and host shortening", () => {
    expect(fleetKey({ name: "demo" })).toBe("demo");
    expect(fleetKey({ host: "home.alexgap.ca", name: "demo" })).toBe("home.alexgap.ca:demo");
    expect(splitFleetKey("home.alexgap.ca:demo")).toEqual({ host: "home.alexgap.ca", name: "demo" });
    expect(splitFleetKey("demo")).toEqual({ name: "demo" });
    expect(shortHost("home.alexgap.ca")).toBe("home");
  });
});

describe("importPayload", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-test-"));
    process.env.AGENTMGR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  function payload(dir: string, name = "migrated"): string {
    const now = new Date().toISOString();
    const state: AgentState = {
      name,
      status: "working", // import must force exited
      dir,
      tmuxSession: "agentmgr-migrated",
      sessionId: "abc-123",
      task: "do things",
      createdAt: now,
      updatedAt: now,
    };
    return JSON.stringify({ state, queue: ["pending one", "pending two"] });
  }

  test("imports state as exited and carries the queue", () => {
    const dir = join(home, "workdir");
    mkdirSync(dir, { recursive: true });
    expect(importPayload(payload(dir))).toBe("migrated");

    const agent = readAgent("migrated")!;
    expect(agent.status).toBe("exited");
    expect(agent.sessionId).toBe("abc-123");
    expect(queueList("migrated").map((m) => m.message)).toEqual(["pending one", "pending two"]);
  });

  test("refuses name collisions and missing dirs", () => {
    const dir = join(home, "workdir");
    mkdirSync(dir, { recursive: true });
    importPayload(payload(dir));
    expect(() => importPayload(payload(dir))).toThrow(/already exists/);
    expect(() => importPayload(payload(join(home, "nope"), "other"))).toThrow(/does not exist/);
  });
});

describe("dirtyGitFiles", () => {
  test("non-repo is clean; dirty repo lists files", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-git-"));
    try {
      expect(dirtyGitFiles(dir)).toEqual([]);
      Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
      expect(dirtyGitFiles(dir)).toEqual([]);
      writeFileSync(join(dir, "f.txt"), "x");
      expect(dirtyGitFiles(dir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
