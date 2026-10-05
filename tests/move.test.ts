import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultMoveTarget,
  exportCommand,
  importAfterRenew,
  importPayload,
  mapHomeDir,
  parseMoveSpec,
  targetTranscriptPath,
  resolveSourceRemovalFailure,
} from "../src/commands/move";
import { fleetKey, fleetPickerItem, sidebarStatus, sortFleetRows, splitFleetKey } from "../src/fleet";
import { shortHost } from "../src/config";
import { readAgent, type AgentState } from "../src/state";
import { acquireDeliverLock, releaseDeliverLock } from "../src/deliver";
import { injectCollected } from "../src/daemon";
import { removeAgent } from "../src/state";
import { queueAppend, queueAppendOnce, queueClear, queueHasId, queueList, queueReceived, queueRecordReceipt, queueStorageExists } from "../src/queue";
import { handoffPath } from "../src/mailbox";

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

describe("sidebar status labels", () => {
  test("shows every operational state explicitly", () => {
    expect(sidebarStatus("starting")).toBe("starting");
    expect(sidebarStatus("working")).toBe("working");
    expect(sidebarStatus("waiting")).toBe("waiting");
    expect(sidebarStatus("idle")).toBe("idle");
    expect(sidebarStatus("needs-attention")).toBe("needs you");
    expect(sidebarStatus("exited")).toBe("exited");
    expect(sidebarStatus("dead")).toBe("dead");
  });
});

describe("sidebar status age", () => {
  test("shows the status transition age on the list row and in details", () => {
    const statusChangedAt = new Date(Date.now() - 70_000).toISOString();
    const item = fleetPickerItem({
      name: "demo",
      status: "working",
      statusChangedAt,
      updatedAt: new Date().toISOString(),
      provider: "codex",
      queued: 0,
      dir: "/tmp",
    });

    expect(item.statusAge).toBe("1m ago");
    expect(item.meta).toContain("since    1m ago");
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

  test("export cannot snapshot ingestion while the source delivery lock is held", () => {
    importPayload(payload(home));
    expect(acquireDeliverLock("migrated")).toBe(true);
    try {
      expect(() => exportCommand("migrated")).toThrow("retry the export");
    } finally {
      releaseDeliverLock("migrated");
    }
  });

  test("handoff keeps source ingestion deferred across exporter processes until completion", async () => {
    importPayload(payload(home));
    const cli = join(import.meta.dir, "../src/index.ts");
    const exported = Bun.spawnSync([process.execPath, cli, "__export", "migrated", "handoff", "transfer"], { env: { ...process.env } });
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout.toString()).handoffToken).toBe("transfer");
    const entry = { msgId: "HANDOFF_MESSAGE", to: "migrated", from: "lead", fromHost: "remote", body: "new message", queuedAt: new Date().toISOString(), ttlMs: 10000 };
    expect(await injectCollected(entry, "remote")).toBe(false);
    exportCommand("migrated", "release", "wrong-transfer");
    expect(await injectCollected(entry, "remote")).toBe(false);
    exportCommand("migrated", "release", "transfer");
    expect(await injectCollected(entry, "remote")).toBe(true);
    expect(queueHasId("migrated", entry.msgId)).toBe(true);
  });

  test("handoff fences local enqueue after the exported snapshot", () => {
    importPayload(payload(home));
    const log = console.log;
    try {
      console.log = () => {};
      exportCommand("migrated", "handoff", "transfer");
    } finally { console.log = log; }
    expect(() => queueAppend("migrated", "late local message")).toThrow(/being moved/);
    expect(queueList("migrated").map(entry => entry.message)).not.toContain("late local message");
    exportCommand("migrated", "release", "transfer");
  });

  test("an expired abandoned handoff can be retried", () => {
    importPayload(payload(home));
    writeFileSync(handoffPath("migrated"), JSON.stringify({ token: "dead", expiresAt: Date.now() - 1 }));
    expect(() => queueAppend("migrated", "after crash")).not.toThrow();
    expect(acquireDeliverLock("migrated")).toBe(true);
    releaseDeliverLock("migrated");
  });

  test("a producer resolved before source deletion cannot recreate its mailbox", async () => {
    importPayload(payload(home));
    const queueModule = JSON.stringify(join(import.meta.dir, "../src/queue.ts"));
    const stateModule = JSON.stringify(join(import.meta.dir, "../src/state.ts"));
    const child = Bun.spawn([process.execPath, "-e", `
      import { queueAppendForAgent } from ${queueModule};
      import { readAgent } from ${stateModule};
      import { existsSync, writeFileSync } from "node:fs";
      if (!readAgent("migrated")) process.exit(2);
      writeFileSync(process.env.AGENTMGR_HOME + "/resolved", "");
      while (!existsSync(process.env.AGENTMGR_HOME + "/continue")) await Bun.sleep(1);
      try { queueAppendForAgent("migrated", "late"); process.exit(3); }
      catch { process.exit(0); }
    `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    while (!existsSync(join(home, "resolved"))) await Bun.sleep(1);
    queueClear("migrated");
    removeAgent("migrated");
    writeFileSync(join(home, "continue"), "");
    expect(await child.exited).toBe(0);
    expect(queueStorageExists("migrated")).toBe(false);
  });

  test("a failed pre-import renewal leaves no destination and can retry", async () => {
    const raw = payload(home);
    await expect(importAfterRenew(raw, async () => { throw new Error("renew failed"); })).rejects.toThrow("renew failed");
    expect(readAgent("migrated")).toBeNull();
    expect(queueStorageExists("migrated")).toBe(false);
    await importAfterRenew(raw, async () => {});
    expect(readAgent("migrated")).not.toBeNull();
  });

  test("an imported destination stays fenced until source commit", async () => {
    await importAfterRenew(payload(home), async () => {}, "local-commit");
    const entry = { msgId: "DURING_COMMIT", to: "migrated", from: "lead", fromHost: "remote", body: "new message", queuedAt: new Date().toISOString(), ttlMs: 10000 };
    expect(await injectCollected(entry, "remote")).toBe(false);
    expect(queueHasId("migrated", entry.msgId)).toBe(false);
    exportCommand("migrated", "release", "local-commit");
    expect(await injectCollected(entry, "remote")).toBe(true);
  });

  test("ambiguous source removal retains the imported destination", () => {
    const raw = payload(home);
    const original = (JSON.parse(raw) as { state: AgentState }).state;
    importPayload(raw);
    const imported = readAgent("migrated")!;
    const importedQueue = queueList("migrated");

    const unreachable = resolveSourceRemovalFailure(
      "migrated", imported, importedQueue, original,
      { exitCode: 255, stdout: "", stderr: "connection lost" },
    );
    expect(unreachable).toEqual({ source: "uncertain", rolledBack: false });
    expect(readAgent("migrated")).not.toBeNull();

    const committedButErrored = resolveSourceRemovalFailure(
      "migrated", imported, importedQueue, original,
      { exitCode: 0, stdout: "[]", stderr: "" },
    );
    expect(committedButErrored).toEqual({ source: "gone", rolledBack: false });
    expect(readAgent("migrated")).not.toBeNull();
  });

  test("failed source removal rolls back only when the original is confirmed present", () => {
    const raw = payload(home);
    const original = (JSON.parse(raw) as { state: AgentState }).state;
    importPayload(raw);
    const imported = readAgent("migrated")!;
    const recovery = resolveSourceRemovalFailure(
      "migrated", imported, queueList("migrated"), original,
      { exitCode: 0, stdout: JSON.stringify([original]), stderr: "" },
    );
    expect(recovery).toEqual({ source: "present", rolledBack: true });
    expect(readAgent("migrated")).toBeNull();
    expect(queueStorageExists("migrated")).toBe(false);
  });

  test("remote ingestion stays unacknowledged when the source disappears during handoff", async () => {
    importPayload(payload(home));
    const log = console.log;
    try {
      console.log = () => {};
      exportCommand("migrated", "handoff", "transfer");
    } finally { console.log = log; }
    removeAgent("migrated");
    const entry = { msgId: "IN_FLIGHT", to: "migrated", from: "lead", fromHost: "remote", body: "new message", queuedAt: new Date().toISOString(), ttlMs: 10000 };
    expect(await injectCollected(entry, "remote")).toBe(false);
    exportCommand("migrated", "release", "transfer");
  });

  test("handoff release works after source removal", () => {
    importPayload(payload(home));
    const log = console.log;
    try {
      console.log = () => {};
      exportCommand("migrated", "handoff", "transfer");
    } finally {
      console.log = log;
    }
    removeAgent("migrated");
    exportCommand("migrated", "release", "transfer");
    expect(acquireDeliverLock("migrated")).toBe(true);
    releaseDeliverLock("migrated");
  });

  test("exports and imports message identities and consumed receipts without changing FIFO", () => {
    const dir = join(home, "workdir");
    mkdirSync(dir, { recursive: true });
    const original = JSON.parse(payload(dir));
    original.queue = ["migration brief", "remote message", "local message"];
    original.queueIds = [null, "0000000000REMOTE", null];
    original.receivedMsgIds = ["0000000000CONSUMED"];
    importPayload(JSON.stringify(original));

    let exported = "";
    const log = console.log;
    try {
      console.log = (raw: string) => { exported = raw; };
      exportCommand("migrated");
    } finally {
      console.log = log;
    }
    const moved = JSON.parse(exported);
    expect(moved.queue).toEqual(original.queue);
    expect(moved.queueIds).toEqual(original.queueIds);
    expect(moved.receivedMsgIds).toEqual(original.receivedMsgIds);
    moved.state.name = "destination";
    moved.state.tmuxSession = "agentmgr-destination";
    importPayload(JSON.stringify(moved));

    expect(queueList("destination").map((entry) => entry.message)).toEqual(original.queue);
    expect(queueHasId("destination", "0000000000REMOTE")).toBe(true);
    expect(queueReceived("destination", "0000000000CONSUMED")).toBe(true);
    queueAppendOnce("destination", "duplicate remote message", "0000000000REMOTE");
    if (!queueReceived("destination", "0000000000CONSUMED")) {
      queueAppendOnce("destination", "duplicate consumed message", "0000000000CONSUMED");
      queueRecordReceipt("destination", "0000000000CONSUMED");
    }
    expect(queueList("destination").map((entry) => entry.message)).toEqual(original.queue);
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

  test("re-anchors on the stored task when present", async () => {
    const { migrationBrief } = await import("../src/commands/move");
    const brief = migrationBrief({
      from: "laptop", to: "gapserver", oldDir: "/a", newDir: "/b", clone: false,
      task: "harden the am move feature",
    });
    expect(brief).toContain("assignment is unchanged");
    expect(brief).toContain("harden the am move feature");
  });

  test("omits the task line when no task is stored", async () => {
    const { migrationBrief } = await import("../src/commands/move");
    const brief = migrationBrief({ from: "laptop", to: "gapserver", oldDir: "/a", newDir: "/b", clone: false });
    expect(brief).not.toContain("assignment is unchanged");
    const blank = migrationBrief({ from: "laptop", to: "gapserver", oldDir: "/a", newDir: "/b", clone: false, task: "   " });
    expect(blank).not.toContain("assignment is unchanged");
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

describe("sortFleetRows", () => {
  test("keeps sections together and puts attention before active before idle", () => {
    const base = { provider: "claude", queued: 0, updatedAt: "", dir: "/tmp/app" } as const;
    const rows = [
      { ...base, name: "idle-local", status: "idle" },
      { ...base, name: "needs-local", status: "needs-attention" },
      { ...base, name: "gone-remote", status: "exited", host: "home.example" },
      { ...base, name: "active-remote", status: "working", host: "home.example" },
    ];
    expect(sortFleetRows(rows as never, "host").map((row) => row.name)).toEqual([
      "needs-local",
      "idle-local",
      "active-remote",
      "gone-remote",
    ]);
  });

  test("sorts by most recent activity within each group", () => {
    const base = { provider: "claude", queued: 0, dir: "/tmp/app" } as const;
    const rows = [
      { ...base, name: "older-local", status: "working", updatedAt: "2026-07-20T10:00:00Z" },
      { ...base, name: "newest-remote", status: "idle", updatedAt: "2026-07-22T10:00:00Z", host: "home.example" },
      { ...base, name: "middle-local", status: "needs-attention", updatedAt: "2026-07-21T10:00:00Z" },
    ];

    expect(sortFleetRows(rows as never, "host", "recent").map((row) => row.name)).toEqual([
      "middle-local",
      "older-local",
      "newest-remote",
    ]);
  });

  test("sorts by role within each group and leaves unassigned last", () => {
    const base = { provider: "claude", queued: 0, updatedAt: "", dir: "/tmp/app", status: "idle" } as const;
    const rows = [
      { ...base, name: "none" },
      { ...base, name: "review", role: "reviewer" },
      { ...base, name: "build", role: "builder" },
    ];
    expect(sortFleetRows(rows as never, "host", "role").map((row) => row.name)).toEqual(["build", "review", "none"]);
  });
});

describe("fleetPickerItem spawned-by relationship", () => {
  test("shows who spawned it on the card and nests it under them", () => {
    const base = {
      name: "child",
      spawnedBy: "parent",
      status: "idle",
      provider: "claude",
      queued: 0,
      updatedAt: new Date().toISOString(),
      dir: "/tmp/app",
    } as const;

    expect(fleetPickerItem(base as never).parent).toBe("parent");
    const remote = fleetPickerItem({ ...base, host: "server" } as never);
    expect(remote.parent).toBe("server:parent");
    expect(remote.meta).toContain("parent   parent");
  });

  test("treats agents spawned by the concierge as top-level", () => {
    const item = fleetPickerItem({
      name: "worker",
      spawnedBy: "concierge",
      status: "working",
      provider: "claude",
      queued: 0,
      updatedAt: new Date().toISOString(),
      dir: "/tmp/app",
    } as never);

    expect(item.parent).toBeUndefined();
    expect(item.meta).not.toContain("parent   concierge");
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
