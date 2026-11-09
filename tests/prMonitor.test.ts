import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { flushPrEvents, parsePrUrl, parsePullRequest, pollPullRequests, recordPrObservations, trackPullRequests, type PrCommand, type TrackedPullRequest } from "../src/prMonitor";
import { queueAppendOnceLocked, queueDepth, queuePop, queueRecordReceipt } from "../src/queue";
import { acquireMailboxLock, releaseMailboxLock } from "../src/mailbox";

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
function api(value: TrackedPullRequest) { return { ...value, mergeCommit: value.mergeCommit ? { oid: value.mergeCommit } : null }; }

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
  recordPrObservations(owner, [pr("MERGED")]);
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

test("explicit registration validates URLs and API identity", async () => {
  const owner = agent("owner", "exited");
  expect(() => parsePrUrl("https://evil.test/owner/repo/pull/1")).toThrow();
  expect(() => parsePullRequest("owner/repo", api({ ...pr("MERGED"), mergeCommit: undefined }))).toThrow();
  await expect(trackPullRequests(owner, [pr().url], async () => JSON.stringify(api(pr("OPEN", 2))))).rejects.toThrow("different PR");
  await trackPullRequests(owner, [pr().url, pr("OPEN", 2).url], async (_cwd, _exe, args) => JSON.stringify(api(pr("OPEN", Number(args[2])))));
  expect(readAgent(owner.name)?.prMonitor?.pullRequests).toHaveLength(2);
});

test("one unavailable PR does not block other stack layers", async () => {
  const owner = agent("owner", "exited");
  recordPrObservations(owner, [pr(), pr("OPEN", 2)]);
  await pollPullRequests(async (_cwd, _exe, args) => {
    if (args[2] === "1") throw new Error("not found");
    return JSON.stringify(api(pr("MERGED", 2)));
  });
  // Pending events survive the partial failure and are drained next sweep.
  flushPrEvents(owner);
  expect(queueDepth(owner.name)).toBe(1);
  expect(readAgent(owner.name)?.prMonitor?.error).toBeTruthy();
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
