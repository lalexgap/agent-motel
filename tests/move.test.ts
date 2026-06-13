import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultMoveTarget,
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


describe("migrationBrief", () => {
  test("move wording names both machines and dirs", async () => {
    const { migrationBrief } = await import("../src/commands/move");
    const brief = migrationBrief({ from: "laptop", to: "gapserver", oldDir: "/Users/x", newDir: "/home/x", clone: false });
    expect(brief).toContain("MOVED");
    expect(brief).toContain("laptop");
    expect(brief).toContain("/home/x");
    expect(brief).toContain("re-verify");
  });

  test("clone wording says the original keeps running", async () => {
    const { migrationBrief } = await import("../src/commands/move");
    const brief = migrationBrief({ from: "laptop", to: "gapserver", oldDir: "/a", newDir: "/b", clone: true });
    expect(brief).toContain("CLONE");
    expect(brief).toContain("original keeps running");
  });
});

describe("premoveNotice", () => {
  test("names the destination and asks for wrap-up", async () => {
    const { premoveNotice } = await import("../src/commands/move");
    const notice = premoveNotice("home.alexgap.ca");
    expect(notice).toContain("about to be MOVED to home.alexgap.ca");
    expect(notice).toContain("Do not start new work");
  });
});

describe("sectionFor", () => {
  test("host mode groups by machine, dir mode by repo (worktrees collapse)", async () => {
    const { sectionFor } = await import("../src/fleet");
    const row = (over: object) => ({
      name: "x", status: "idle", provider: "claude", queued: 0,
      updatedAt: "", dir: "/home/u/code/app", ...over,
    });
    expect(sectionFor(row({}) as never, "host")).toBe("local");
    expect(sectionFor(row({ host: "home.alexgap.ca" }) as never, "host")).toBe("home.alexgap.ca");
    const wt = row({ dir: "/home/u/.agent-manager/worktrees/app/x", repoRoot: "/home/u/code/app" });
    expect(sectionFor(wt as never, "dir")).toBe("app");
    // same project, different machine/home/symlink spellings → one section
    expect(sectionFor(row({ dir: "/Users/u/code/app" }) as never, "dir")).toBe("app");
    expect(sectionFor(row({ dir: "/mnt/fastdata/code/app" }) as never, "dir")).toBe("app");
  });
});

describe("swallowed-Enter detection", () => {
  const SEP = "─".repeat(40);

  test("multi-line claude sends get a paste-settle delay", async () => {
    const { enterDelayMs } = await import("../src/deliver");
    const claude = { name: "x", provider: "claude" } as never;
    expect(enterDelayMs(claude, "one line")).toBeUndefined();
    expect(enterDelayMs(claude, "[am] line one\nline two")).toBe(200);
  });

  test("looksUnsubmitted spots the message stuck in the input box", async () => {
    const { looksUnsubmitted } = await import("../src/deliver");
    const msg = "[am] You were just MOVED to a different machine: blah\nmore";
    const stuck = ["⏺ earlier reply", SEP, "❯ [am] You were just MOVED to a diff", "  erent machine: blah more", SEP, "  1 shell"];
    const submitted = ["❯ [am] You were just MOVED to a different machine: blah", "⏺ Re-orienting…", SEP, "❯ ", SEP, "  30k tokens"];
    expect(looksUnsubmitted(stuck, msg)).toBe(true);
    expect(looksUnsubmitted(submitted, msg)).toBe(false);
  });
});

describe("inputBoxText (composing guard)", () => {
  const SEP = "─".repeat(40);

  test("empty box and placeholder read as empty; human text doesn't", async () => {
    const { inputBoxText } = await import("../src/deliver");
    expect(inputBoxText([SEP, "❯ ", SEP, " status"])).toBe("");
    expect(inputBoxText([SEP, '❯ Try "fix lint errors"', SEP, " status"])).toBe("");
    expect(inputBoxText([SEP, "❯ are we sure", SEP, " status"])).toBe("are we sure");
  });
});
