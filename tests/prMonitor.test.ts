import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { flushPrEvents, parsePrUrl, parsePullRequest, pollPullRequests, recordPrObservations, trackPullRequests, type PrCommand, type TrackedPullRequest } from "../src/prMonitor";
import { queueAppendOnceLocked, queueDepth, queueList, queuePop, queueReceived, queueRecordReceipt } from "../src/queue";
import { acquireMailboxLock, releaseMailboxLock } from "../src/mailbox";
import { acquireLifecycleLock, releaseLifecycleLock } from "../src/lifecycle";
import { exportCommand } from "../src/commands/move";

let home: string;
let originalHome: string | undefined;
beforeEach(() => {
  originalHome = process.env.AGENTMGR_HOME;
  home = mkdtempSync(join(tmpdir(), "am-pr-test-"));
  process.env.AGENTMGR_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.AGENTMGR_HOME;
  else process.env.AGENTMGR_HOME = originalHome;
});
function agent(name = "owner", status: AgentState["status"] = "working"): AgentState {
  const value: AgentState = { name, status, dir: home, tmuxSession: `agentmgr-${name}`, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  writeAgent(value);
  return value;
}
function pr(state: TrackedPullRequest["state"] = "OPEN", number = 1, day = 2): TrackedPullRequest {
  return { repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, state, updatedAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    ...(state === "MERGED" ? { mergeCommit: "a".repeat(40), mergedAt: "2026-01-02T00:00:00Z" } : {}),
    ...(state === "CLOSED" ? { closedAt: "2026-01-02T00:00:00Z" } : {}) };
}
function api(value: TrackedPullRequest, headRepository = value.repository) {
  return { ...value, headRepository: { nameWithOwner: headRepository }, mergeCommit: value.mergeCommit ? { oid: value.mergeCommit } : null };
}
const headA = "1".repeat(40), headB = "2".repeat(40);
function conflicted(headSha = headA, mergeable: TrackedPullRequest["mergeable"] = "CONFLICTING", day = 2): TrackedPullRequest {
  return { ...pr("OPEN", 1, day), headSha, mergeable };
}

test("conflicts alert once per known episode or head and survive unknown observations", () => {
  const owner = agent();
  const delivered: unknown[][] = [];
  recordPrObservations(owner, [conflicted()]);
  flushPrEvents(owner, (...args) => delivered.push(args));
  expect(queueDepth(owner.name)).toBe(1);
  expect(queuePop(owner.name)).toContain(headA);
  expect(delivered).toEqual([[owner.name, expect.stringContaining("merge conflicts"), pr().url, "PR #1 has merge conflicts"]]);

  recordPrObservations(readAgent(owner.name)!, [conflicted(headA, "CONFLICTING", 3)]);
  recordPrObservations(readAgent(owner.name)!, [conflicted(headA, "UNKNOWN", 4)]);
  recordPrObservations(readAgent(owner.name)!, [conflicted(headA, "CONFLICTING", 5)]);
  flushPrEvents(readAgent(owner.name)!);
  expect(queueDepth(owner.name)).toBe(0);

  recordPrObservations(readAgent(owner.name)!, [conflicted(headA, "MERGEABLE", 6)]);
  recordPrObservations(readAgent(owner.name)!, [conflicted(headA, "CONFLICTING", 7)]);
  flushPrEvents(readAgent(owner.name)!);
  expect(queuePop(owner.name)).toContain(headA);

  recordPrObservations(readAgent(owner.name)!, [conflicted(headB, "CONFLICTING", 8)]);
  flushPrEvents(readAgent(owner.name)!);
  expect(queuePop(owner.name)).toContain(headB);
});

test("conflict evidence fails quiet when non-open or missing a valid head", () => {
  const owner = agent();
  recordPrObservations(owner, [{ ...pr("CLOSED"), closedAt: "2025-12-01T00:00:00Z", mergeable: "CONFLICTING", headSha: headA }]);
  recordPrObservations(readAgent(owner.name)!, [{ ...pr("OPEN", 2), mergeable: "CONFLICTING" }]);
  flushPrEvents(readAgent(owner.name)!);
  expect(queueDepth(owner.name)).toBe(0);
});

test("pending conflict recovery retains dedup state, URL, and desktop title", () => {
  const owner = agent();
  recordPrObservations(owner, [conflicted()]);
  const saved = readAgent(owner.name)!;
  expect(saved.prMonitor!.pending![0]).toMatchObject({ url: pr().url, title: "PR #1 has merge conflicts" });
  recordPrObservations(saved, [conflicted(headA, "UNKNOWN", 3)]);
  recordPrObservations(readAgent(owner.name)!, [conflicted(headA, "CONFLICTING", 4)]);
  expect(readAgent(owner.name)!.prMonitor!.pending).toHaveLength(1);
});

test("open baseline is quiet, merge queues once, even after consumption/restart", () => {
  const owner = agent();
  recordPrObservations(owner, [pr()]);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(0);
  recordPrObservations(owner, [pr("MERGED")]);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(1);
  expect(queuePop(owner.name)).toContain(`merged at ${"a".repeat(40)}`);
  recordPrObservations(readAgent(owner.name)!, [pr("MERGED", 1, 3)]);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(0);
});

test("monitor bookkeeping preserves agent activity age", async () => {
  const owner = agent("owner", "exited");
  const updatedAt = readAgent(owner.name)!.updatedAt;
  recordPrObservations(owner, [pr()]);
  expect(readAgent(owner.name)!.updatedAt).toBe(updatedAt);
  await pollPullRequests(async () => { throw new Error("offline"); });
  expect(readAgent(owner.name)!.updatedAt).toBe(updatedAt);
  recordPrObservations(readAgent(owner.name)!, [pr("MERGED")]);
  flushPrEvents(readAgent(owner.name)!);
  expect(readAgent(owner.name)!.updatedAt).toBe(updatedAt);
});

test("exited agents retain multiple PRs and queued merge notices", async () => {
  const owner = agent("owner", "exited");
  recordPrObservations(owner, [pr(), pr("OPEN", 2)]);
  const calls: string[][] = [];
  const run: PrCommand = async (_cwd, executable, args) => {
    expect(executable).toBe("gh");
    calls.push(args);
    return JSON.stringify(api(pr("MERGED", Number(args[2]))));
  };
  await pollPullRequests(run);
  expect(calls).toHaveLength(2);
  expect(queueDepth(owner.name)).toBe(2);
  expect(readAgent(owner.name)?.status).toBe("exited");
  await pollPullRequests(run);
  expect(calls).toHaveLength(2); // immutable merged PRs no longer consume API calls
  expect(queueDepth(owner.name)).toBe(2);
});

test("a crash between enqueue and receipt reuses the queued entry", () => {
  const owner = agent();
  recordPrObservations(owner, [pr("MERGED")]);
  const event = readAgent(owner.name)!.prMonitor!.pending![0]!;
  expect(acquireMailboxLock(owner.name)).toBe(true);
  queueAppendOnceLocked(owner.name, event.message, event.id);
  releaseMailboxLock(owner.name);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(1);
  expect(readAgent(owner.name)?.prMonitor?.pending).toEqual([]);
});

test("durable pending recovery propagates the PR URL and accepts legacy missing metadata", () => {
  const owner = agent();
  recordPrObservations(owner, [pr("MERGED")]);
  expect(readAgent(owner.name)!.prMonitor!.pending![0]!.url).toBe(pr().url);
  const delivered: unknown[][] = [];
  flushPrEvents(readAgent(owner.name)!, (...args) => delivered.push(args));
  expect(delivered).toEqual([[owner.name, expect.stringContaining("merged at"), pr().url]]);

  const legacyOwner = agent("legacy");
  recordPrObservations(legacyOwner, [pr("CLOSED")]);
  const legacy = readAgent(legacyOwner.name)!;
  delete legacy.prMonitor!.pending![0]!.url;
  writeAgent(legacy);
  flushPrEvents(readAgent(legacyOwner.name)!, (...args) => delivered.push(args));
  expect(delivered.at(-1)).toEqual([legacyOwner.name, expect.stringContaining("closed without merging"), undefined]);
});

test("a crash after receipt and consumer drain does not recreate a notification", () => {
  const owner = agent();
  recordPrObservations(owner, [pr("MERGED")]);
  const event = readAgent(owner.name)!.prMonitor!.pending![0]!;
  expect(acquireMailboxLock(owner.name)).toBe(true);
  queueAppendOnceLocked(owner.name, event.message, event.id);
  queueRecordReceipt(owner.name, event.id);
  releaseMailboxLock(owner.name);
  queuePop(owner.name);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(0);
});

test("recovered pending events must sync state before enqueue after a directory fsync failure", async () => {
  const owner = agent("owner", "exited");
  recordPrObservations(owner, [pr()]);
  const updatedAt = readAgent(owner.name)!.updatedAt;
  const opened = new Map<number, string>();
  const synced: string[] = [];
  const open = fs.openSync, sync = fs.fsyncSync;
  let fail = true;
  const openSpy = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    opened.set(fd, String(args[0]));
    return fd;
  });
  const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const path = opened.get(fd)!;
    if (fail && path === join(home, "agents")) throw new Error("state directory fsync failed");
    sync(fd);
    synced.push(path);
  });
  const run: PrCommand = async () => JSON.stringify(api(pr("MERGED")));
  try {
    await pollPullRequests(run);
    const event = readAgent(owner.name)!.prMonitor!.pending![0]!;
    expect(event).toBeDefined();
    expect(queueDepth(owner.name)).toBe(0);
    expect(() => flushPrEvents(owner, undefined, true)).toThrow("state directory fsync failed");
    for (let attempt = 0; attempt < 2; attempt++) {
      await pollPullRequests(run);
      expect(queueDepth(owner.name)).toBe(0);
      expect(queueReceived(owner.name, event.id)).toBe(false);
      expect(readAgent(owner.name)!.prMonitor!.pending).toEqual([event]);
    }
    fail = false;
    synced.length = 0;
    await pollPullRequests(run);
    expect(synced.slice(0, 3)).toEqual([
      join(home, "agents", `${owner.name}.json.${process.pid}.tmp`),
      join(home, "agents"),
      join(home, "queue", owner.name, `${event.id}.json`),
    ]);
    expect(queueList(owner.name).map(entry => entry.msgId)).toEqual([event.id]);
    expect(queueReceived(owner.name, event.id)).toBe(true);
    expect(readAgent(owner.name)!.prMonitor!.pending).toEqual([]);
    expect(readAgent(owner.name)!.updatedAt).toBe(updatedAt);
    queuePop(owner.name);
    await pollPullRequests(run);
    expect(queueDepth(owner.name)).toBe(0);
  } finally {
    syncSpy.mockRestore();
    openSpy.mockRestore();
  }
});

test("busy mailbox defers durable events and preserves transition order", () => {
  const owner = agent();
  recordPrObservations(owner, [pr()]);
  expect(acquireMailboxLock(owner.name)).toBe(true);
  recordPrObservations(owner, [pr("CLOSED")]);
  flushPrEvents(owner);
  recordPrObservations(owner, [pr("OPEN", 1, 3)]);
  expect(queueDepth(owner.name)).toBe(0);
  releaseMailboxLock(owner.name);
  flushPrEvents(owner);
  expect(queuePop(owner.name)).toContain("closed without merging");
  expect(queuePop(owner.name)).toContain("reopened");
});

test("old terminal PRs seed state without historical notification spam", () => {
  const owner = agent();
  recordPrObservations(owner, [{ ...pr("MERGED"), mergedAt: "2025-12-01T00:00:00Z" }, { ...pr("CLOSED", 2), closedAt: "2025-12-01T00:00:00Z" }]);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(0);
});

test("stale observations and recycled agent names cannot receive old events", () => {
  const owner = agent();
  recordPrObservations(owner, [pr("CLOSED", 1, 4)]);
  recordPrObservations(owner, [pr("OPEN", 1, 3)]);
  expect(readAgent(owner.name)?.prMonitor?.pullRequests[0]?.state).toBe("CLOSED");
  writeAgent({ ...owner, createdAt: "2026-02-01T00:00:00Z" });
  expect(() => recordPrObservations(owner, [pr("MERGED")])).toThrow(/changed.*retry/);
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(0);
  expect(readAgent(owner.name)?.prMonitor).toBeUndefined();
});

test("shared PRs fetched once and notified independently", async () => {
  const a = agent("a", "exited"), b = agent("b", "exited");
  recordPrObservations(a, [pr()]); recordPrObservations(b, [pr()]);
  let calls = 0;
  await pollPullRequests(async () => { calls++; return JSON.stringify(api(pr("MERGED"))); });
  expect(calls).toBe(1);
  expect(queueDepth("a")).toBe(1); expect(queueDepth("b")).toBe(1);
});

test("API failures retain tracked state and retry next sweep", async () => {
  const owner = agent("owner", "exited");
  recordPrObservations(owner, [pr()]);
  await pollPullRequests(async () => { throw new Error("rate limited"); });
  expect(readAgent(owner.name)?.prMonitor?.pullRequests[0]?.state).toBe("OPEN");
  expect(readAgent(owner.name)?.prMonitor?.error).toContain("retrying");
  await pollPullRequests(async () => JSON.stringify(api(pr("MERGED"))));
  expect(readAgent(owner.name)?.prMonitor?.error).toBeUndefined();
  expect(queueDepth(owner.name)).toBe(1);
});

test("current branch discovery persists ownership across branch changes", async () => {
  const owner = agent();
  let branch = "feature";
  const run: PrCommand = async (_cwd, executable, args) => {
    if (executable === "git") return args[0] === "remote" ? "git@github.com:owner/repo.git\n" : branch;
    if (args[1] === "list") return JSON.stringify([api(pr())]);
    return JSON.stringify(api(pr("MERGED")));
  };
  await pollPullRequests(run);
  branch = "main";
  await pollPullRequests(run);
  expect(queueDepth(owner.name)).toBe(1);
});

test("branch discovery excludes same-named branches from forks", async () => {
  const owner = agent();
  await pollPullRequests(async (_cwd, executable, args) => {
    if (executable === "git") return args[0] === "remote" ? "git@github.com:owner/repo.git\n" : "feature\n";
    return JSON.stringify([api(pr(), "contributor/repo")]);
  });
  expect(readAgent(owner.name)?.prMonitor).toBeUndefined();
  expect(queueDepth(owner.name)).toBe(0);
});

test("explicit registration validates URLs and API identity", async () => {
  const owner = agent("owner", "exited");
  expect(() => parsePrUrl("https://evil.test/owner/repo/pull/1")).toThrow();
  expect(() => parsePrUrl(`${pr().url}/`)).toThrow();
  expect(() => parsePullRequest("owner/repo", api({ ...pr("MERGED"), mergeCommit: undefined }))).toThrow();
  expect(() => parsePullRequest("owner/repo", { ...api(pr()), headRefOid: "bad" })).toThrow(/head/);
  expect(() => parsePullRequest("owner/repo", { ...api(pr()), mergeable: "BROKEN" })).toThrow(/mergeability/);
  await expect(trackPullRequests(owner, [pr().url], async () => JSON.stringify(api(pr("OPEN", 2))))).rejects.toThrow("different PR");
  await trackPullRequests(owner, [pr().url, pr("OPEN", 2).url], async (_cwd, _exe, args) => JSON.stringify(api(pr("OPEN", Number(args[2])))));
  expect(readAgent(owner.name)?.prMonitor?.pullRequests).toHaveLength(2);
});

test("explicit registration rejects lifecycle and pull-handoff barriers", async () => {
  const owner = agent("owner", "exited");
  const run: PrCommand = async () => JSON.stringify(api(pr()));
  expect(acquireLifecycleLock(owner.name)).toBe(true);
  try {
    await expect(trackPullRequests(owner, [pr().url], run)).rejects.toThrow(/lifecycle is busy.*retry/);
  } finally { releaseLifecycleLock(owner.name); }
  expect(readAgent(owner.name)?.prMonitor).toBeUndefined();

  const log = console.log;
  try {
    console.log = () => {};
    exportCommand(owner.name, "handoff", "transfer");
  } finally { console.log = log; }
  await expect(trackPullRequests(owner, [pr().url], run)).rejects.toThrow(/being moved.*retry/);
  expect(readAgent(owner.name)?.prMonitor).toBeUndefined();
  exportCommand(owner.name, "release", "transfer");
});

test("one unavailable PR does not block other stack layers", async () => {
  const owner = agent("owner", "exited");
  recordPrObservations(owner, [pr(), pr("OPEN", 2)]);
  await pollPullRequests(async (_cwd, _exe, args) => {
    if (args[2] === "1") throw new Error("not found");
    return JSON.stringify(api(pr("MERGED", 2)));
  });
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(1);
  expect(readAgent(owner.name)?.prMonitor?.error).toBeTruthy();
});

test("failed discovery still advances available tracked PRs without completing bootstrap", async () => {
  const owner = agent();
  recordPrObservations(owner, [pr(), pr("OPEN", 2)]);
  await pollPullRequests(async (_cwd, executable, args) => {
    if (executable === "git" || args[2] === "2") throw new Error("unavailable");
    return JSON.stringify(api(pr("MERGED")));
  });
  const monitor = readAgent(owner.name)!.prMonitor!;
  expect(monitor.pullRequests.map(pr => pr.state)).toEqual(["MERGED", "OPEN"]);
  expect(monitor.bootstrapped).toBeUndefined();
  expect(monitor.error).toContain("retrying");
  expect(queueDepth(owner.name)).toBe(1);
});

test("stopping the watcher discards in-flight observations", async () => {
  const owner = agent("owner", "exited");
  recordPrObservations(owner, [pr()]);
  let active = true;
  await pollPullRequests(async () => { active = false; return JSON.stringify(api(pr("MERGED"))); }, () => active);
  expect(readAgent(owner.name)?.prMonitor?.pullRequests[0]?.state).toBe("OPEN");
  expect(queueDepth(owner.name)).toBe(0);
});

test("exited worktree owners can bootstrap without using the current checkout branch", async () => {
  const owner = agent("owner", "exited");
  owner.worktreeBranch = "am/owner";
  writeAgent(owner);
  await pollPullRequests(async (_cwd, exe, args) => {
    if (exe === "git") { expect(args[0]).toBe("remote"); return "https://github.com/owner/repo.git"; }
    expect(args).toContain("--head=am/owner");
    return JSON.stringify([api(pr("MERGED"))]);
  });
  expect(queueDepth(owner.name)).toBe(1);
});

test("exited bootstrap uses surviving directories when the worktree was removed", async () => {
  const owner = agent("owner", "exited");
  owner.worktreeBranch = "am/owner";
  owner.dir = join(home, "removed-worktree");
  owner.repoRoot = join(home, "repo");
  fs.mkdirSync(owner.repoRoot);
  writeAgent(owner);
  expect(fs.existsSync(owner.dir)).toBe(false);
  const commands: string[] = [];
  await pollPullRequests(async (cwd, executable, args) => {
    commands.push(executable);
    expect(fs.existsSync(cwd)).toBe(true);
    if (executable === "git") {
      expect(cwd).toBe(owner.repoRoot!);
      expect(args).toEqual(["remote", "get-url", "origin"]);
      return "https://github.com/owner/repo.git";
    }
    expect(cwd).toBe(home);
    expect(args).toContain("--head=am/owner");
    return JSON.stringify([api(pr("MERGED"))]);
  });
  expect(commands).toEqual(["git", "gh"]);
  expect(readAgent(owner.name)?.prMonitor?.bootstrapped).toBe(true);
  expect(queueDepth(owner.name)).toBe(1);
});

test.each([
  ["git", false], ["git", true], ["gh", false], ["gh", true],
] as const)("repeated %s bootstrap failures retry until success (empty=%s)", async (failure, empty) => {
  const owner = agent("owner", "exited");
  owner.worktreeBranch = "am/owner";
  writeAgent(owner);
  const updatedAt = readAgent(owner.name)!.updatedAt;
  let attempts = 0;
  const run: PrCommand = async (_cwd, executable) => {
    if (executable === failure && ++attempts <= 3) throw new Error("temporary failure");
    if (executable === "git") return "https://github.com/owner/repo.git";
    return JSON.stringify(empty ? [] : [api(pr("MERGED")), api({ ...pr("CLOSED", 2), closedAt: "2025-12-01T00:00:00Z" })]);
  };
  for (let sweep = 1; sweep <= 3; sweep++) {
    await pollPullRequests(run);
    expect(attempts).toBe(sweep);
    expect(readAgent(owner.name)?.prMonitor).toMatchObject({ pullRequests: [], error: expect.stringContaining("retrying") });
    expect(readAgent(owner.name)?.prMonitor?.bootstrapped).toBeUndefined();
    expect(queueDepth(owner.name)).toBe(0);
  }
  await pollPullRequests(run);
  expect(attempts).toBe(4);
  expect(readAgent(owner.name)?.prMonitor?.bootstrapped).toBe(true);
  expect(readAgent(owner.name)?.prMonitor?.error).toBeUndefined();
  expect(readAgent(owner.name)?.updatedAt).toBe(updatedAt);
  expect(queueDepth(owner.name)).toBe(empty ? 0 : 1);
  let discoveryCalls = 0;
  await pollPullRequests(async (_cwd, executable, args) => {
    if (executable === "git" || args[1] === "list") discoveryCalls++;
    return JSON.stringify(api({ ...pr("CLOSED", 2), closedAt: "2025-12-01T00:00:00Z" }));
  });
  expect(discoveryCalls).toBe(0);
  expect(queueDepth(owner.name)).toBe(empty ? 0 : 1);
});

test("CLI entrypoint parses with the shebang first", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/index.ts"), "--help"], {
    env: { ...process.env, AGENTMGR_HOME: home, AGENTMGR_SYSTEMD: "0", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Agent Motel (am)");
  expect(result.stdout.toString()).toContain("--ready [--dir review-worktree]");
  expect(result.stderr.toString()).toBe("");
});
