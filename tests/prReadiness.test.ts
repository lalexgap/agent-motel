import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLifecycleLock, releaseLifecycleLock } from "../src/lifecycle";
import { declarePullRequestReady, parseBaseRef, parseReadyPullRequest } from "../src/prReadiness";
import { recordPrObservations, type PrCommand, type TrackedPullRequest } from "../src/prMonitor";
import { queueDepth } from "../src/queue";
import { readAgent, writeAgent, type AgentState } from "../src/state";

let home: string;
let script: string;
const head = "a".repeat(40), base = "b".repeat(40), nextHead = "c".repeat(40);
const url = "https://github.com/owner/repo/pull/7";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-ready-test-"));
  process.env.AGENTMGR_HOME = join(home, "am");
  script = join(home, "review.sh");
  closeSync(openSync(script, "w"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function owner(): AgentState {
  const value: AgentState = { name: "owner-agent", status: "working", dir: home, tmuxSession: "agentmgr-owner", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  writeAgent(value);
  return value;
}
function github(headSha = head, overrides: Record<string, unknown> = {}) {
  return { number: 7, url, state: "OPEN", headRefOid: headSha, baseRefName: "main", baseRefOid: base,
    mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    updatedAt: "2026-01-02T00:00:00Z", ...overrides };
}
function review(headSha = head, overrides: Record<string, unknown> = {}) {
  return { XREVIEW_COVERS_HEAD: "yes", STACK_MAIN_COVERS_HEAD: "yes", STACK_PARENTS_COVERED: "yes",
    SEPARATE_SECURITY_REQUIRED: "no", STACK_SECURITY_COVERS_HEAD: "no",
    layer: { context: { head_sha: headSha, base_ref: "refs/heads/main", base_sha: base },
      main: { blockers: [] }, security: { blockers: [] } }, ...overrides };
}
function runner(snapshots: any[] = [github(), github()], reviewState: any = review(), localHead = head, localBase = base, baseTips = [base, base]): { run: PrCommand; calls: string[][] } {
  let gh = 0, refs = 0;
  const calls: string[][] = [];
  return { calls, run: async (_cwd, executable, args) => {
    calls.push([executable, ...args]);
    if (executable === "gh" && args[0] === "pr") return JSON.stringify(snapshots[gh++]);
    if (executable === "gh" && args[0] === "api") return JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: baseTips[refs++] } });
    if (executable === script) return JSON.stringify(reviewState);
    if (args.includes("--verify")) return localBase;
    return localHead;
  } };
}

describe("GitHub readiness parsing", () => {
  test("accepts successful check runs and status contexts", () => {
    expect(parseReadyPullRequest("owner/repo", 7, github()).headSha).toBe(head);
    expect(parseReadyPullRequest("owner/repo", 7, github(head, { statusCheckRollup: [{ __typename: "StatusContext", state: "SUCCESS" }] })).baseRefOid).toBe(base);
    expect(parseReadyPullRequest("owner/repo", 7, github(head, { reviewDecision: "" })).headSha).toBe(head);
  });

  test("validates the exact live base ref and commit object", () => {
    expect(parseBaseRef("owner/repo", "release/x", { ref: "refs/heads/release/x", object: { type: "commit", sha: base } })).toBe(base);
    expect(() => parseBaseRef("owner/repo", "release/x", { ref: "refs/heads/main", object: { type: "commit", sha: base } })).toThrow(/malformed live base/);
    expect(() => parseBaseRef("owner/repo", "main", { ref: "refs/heads/main", object: { type: "tag", sha: base } })).toThrow(/malformed live base/);
  });

  test.each([
    ["absent", []],
    ["pending", [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }]],
    ["failed", [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]],
    ["skipped", [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]],
    ["neutral", [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" }]],
    ["unknown", [{ __typename: "Other", state: "SUCCESS" }]],
    ["truncated", Array.from({ length: 100 }, () => ({ __typename: "StatusContext", state: "SUCCESS" }))],
  ])("rejects %s CI evidence", (_label, statusCheckRollup) => {
    expect(() => parseReadyPullRequest("owner/repo", 7, github(head, { statusCheckRollup }))).toThrow(/green CI/);
  });

  test.each([
    ["conflicting", { mergeable: "CONFLICTING" }], ["dirty", { mergeStateStatus: "DIRTY" }],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }], ["closed", { state: "CLOSED" }],
  ])("rejects %s GitHub state", (_label, change) => {
    expect(() => parseReadyPullRequest("owner/repo", 7, github(head, change))).toThrow(/readiness withheld/);
  });
});

test("verified readiness persists before one desktop notification without owner queue activity", async () => {
  const agent = owner();
  const { run, calls } = runner();
  const notices: unknown[][] = [];
  const result = await declarePullRequestReady(agent, url, home, { run, reviewScript: script, notify: (...args) => notices.push(args), now: () => "2026-01-03T00:00:00Z" });
  expect(result).toContain("Notified");
  expect(calls.filter(call => call[0] === "gh")).toHaveLength(4);
  expect(calls.filter(call => call[1] === "api")).toEqual([
    ["gh", "api", "repos/owner/repo/git/ref/heads/main"],
    ["gh", "api", "repos/owner/repo/git/ref/heads/main"],
  ]);
  expect(calls.find(call => call[0] === script)).toEqual([script, "stack", "state"]);
  expect(calls).toContainEqual(["git", "rev-parse", "--verify", "refs/heads/main^{commit}"]);
  expect(readAgent(agent.name)?.prMonitor?.pullRequests[0]).toMatchObject({ url, readyNotifiedHead: head, readyNotifiedAt: "2026-01-03T00:00:00Z" });
  expect(queueDepth(agent.name)).toBe(0);
  expect(notices).toEqual([["PR #7 is merge-ready", `owner/repo · owner-agent · ${head.slice(0, 12)}\nReview and CI passed.`, { agent: agent.name, kind: "pr", url }]]);

  const again = await declarePullRequestReady(readAgent(agent.name)!, url, home, { run: runner().run, reviewScript: script, notify: (...args) => notices.push(args) });
  expect(again).toContain("already notified");
  expect(notices).toHaveLength(1);
});

test("new reviewed head can notify and ordinary polls preserve the old marker", async () => {
  const agent = owner();
  await declarePullRequestReady(agent, url, home, { run: runner().run, reviewScript: script, notify: () => {} });
  const existing = readAgent(agent.name)!.prMonitor!.pullRequests[0]!;
  const observation: TrackedPullRequest = { repository: "owner/repo", number: 7, url, state: "OPEN", headSha: head,
    mergeable: "MERGEABLE", updatedAt: "2026-01-04T00:00:00Z" };
  recordPrObservations(readAgent(agent.name)!, [observation]);
  expect(readAgent(agent.name)!.prMonitor!.pullRequests[0]!.readyNotifiedHead).toBe(existing.readyNotifiedHead);

  const notices: unknown[][] = [];
  await declarePullRequestReady(readAgent(agent.name)!, url, home, {
    run: runner([github(nextHead, { updatedAt: "2026-01-05T00:00:00Z" }), github(nextHead, { updatedAt: "2026-01-05T00:00:00Z" })], review(nextHead), nextHead).run,
    reviewScript: script, notify: (...args) => notices.push(args),
  });
  expect(readAgent(agent.name)!.prMonitor!.pullRequests[0]!.readyNotifiedHead).toBe(nextHead);
  expect(notices).toHaveLength(1);
});

test("clears an older conflict episode before readiness and alerts on a same-head re-conflict", async () => {
  const agent = owner();
  recordPrObservations(agent, [{ repository: "owner/repo", number: 7, url, state: "OPEN", headSha: head, mergeable: "CONFLICTING", updatedAt: "2026-01-01T00:00:00Z" }]);
  await expect(declarePullRequestReady(readAgent(agent.name)!, url, home, {
    run: runner([github(head, { updatedAt: "2026-01-02T00:00:00Z" }), github(head, { updatedAt: "2026-01-02T00:00:00Z" })]).run,
    reviewScript: script, notify: () => {},
  })).resolves.toContain("Notified");
  expect(readAgent(agent.name)!.prMonitor!.pullRequests[0]!.conflictActive).toBe(false);
  recordPrObservations(readAgent(agent.name)!, [{ repository: "owner/repo", number: 7, url, state: "OPEN", headSha: head, mergeable: "CONFLICTING", updatedAt: "2026-01-03T00:00:00Z" }]);
  expect(readAgent(agent.name)!.prMonitor!.pending).toHaveLength(2);
});

test("withholds readiness when same-head conflict evidence is equally or more recent", async () => {
  for (const updatedAt of ["2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]) {
    const agent = owner();
    recordPrObservations(agent, [{ repository: "owner/repo", number: 7, url, state: "OPEN", headSha: head, mergeable: "CONFLICTING", updatedAt }]);
    await expect(declarePullRequestReady(readAgent(agent.name)!, url, home, {
      run: runner([github(head, { updatedAt: "2026-01-02T00:00:00Z" }), github(head, { updatedAt: "2026-01-02T00:00:00Z" })]).run,
      reviewScript: script, notify: () => { throw new Error("must not notify"); },
    })).rejects.toThrow(/local conflict evidence/);
    expect(readAgent(agent.name)!.prMonitor!.pullRequests[0]!.readyNotifiedHead).toBeUndefined();
    rmSync(process.env.AGENTMGR_HOME!, { recursive: true, force: true });
  }
});

test("accepts drift-covered review context when the safe base ref resolves to GitHub's live base", async () => {
  const frozenBase = "d".repeat(40);
  const state = review(head, { layer: { context: { head_sha: head, base_ref: "refs/remotes/origin/main", base_sha: frozenBase }, main: { blockers: [] }, security: { blockers: [] } } });
  const stalePr = github(head, { baseRefOid: frozenBase });
  await expect(declarePullRequestReady(owner(), url, home, { run: runner([stalePr, stalePr], state, head, base, [base, base]).run, reviewScript: script, notify: () => {} })).resolves.toContain("Notified");
});

test.each([
  ["missing coverage", { XREVIEW_COVERS_HEAD: "no" }, head, base],
  ["stale head", {}, nextHead, base],
  ["wrong review head", { layer: { context: { head_sha: nextHead, base_ref: "refs/heads/main", base_sha: base }, main: { blockers: [] }, security: { blockers: [] } } }, head, base],
  ["wrong base", { layer: { context: { head_sha: head, base_ref: "refs/heads/other", base_sha: base }, main: { blockers: [] }, security: { blockers: [] } } }, head, base],
  ["uncovered parent", { STACK_PARENTS_COVERED: "no" }, head, base],
  ["missing security", { SEPARATE_SECURITY_REQUIRED: "yes", STACK_SECURITY_COVERS_HEAD: "no" }, head, base],
  ["review blocker", { layer: { context: { head_sha: head, base_ref: "refs/heads/main", base_sha: base }, main: { blockers: [{ severity: "medium" }] }, security: { blockers: [] } } }, head, base],
  ["stale live base", {}, head, "d".repeat(40)],
])("withholds on %s review evidence", async (_label, change, localHead, localBase) => {
  const state = { ...review(), ...change };
  await expect(declarePullRequestReady(owner(), url, home, { run: runner(undefined, state, localHead, localBase).run, reviewScript: script, notify: () => { throw new Error("must not notify"); } })).rejects.toThrow(/readiness withheld/);
});

test("withholds malformed review output and GitHub drift between reads", async () => {
  const malformed: PrCommand = async (_cwd, executable, args) => executable === "gh" && args[0] === "pr" ? JSON.stringify(github())
    : executable === "gh" ? JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: base } })
    : executable === script ? "not-json" : args.includes("--verify") ? base : head;
  await expect(declarePullRequestReady(owner(), url, home, { run: malformed, reviewScript: script })).rejects.toThrow(/malformed review-gate/);
  await expect(declarePullRequestReady(owner(), url, home, { run: runner([github(), github(nextHead)]).run, reviewScript: script })).rejects.toThrow(/changed during verification/);
  await expect(declarePullRequestReady(owner(), url, home, { run: runner(undefined, review(), head, base, [base, "e".repeat(40)]).run, reviewScript: script })).rejects.toThrow(/live base changed/);
});

test("lifecycle ownership and stale owner identity prevent marker writes", async () => {
  const agent = owner();
  expect(acquireLifecycleLock(agent.name)).toBe(true);
  try {
    await expect(declarePullRequestReady(agent, url, home, { run: runner().run, reviewScript: script })).rejects.toThrow(/lifecycle is busy/);
  } finally { releaseLifecycleLock(agent.name); }
  expect(readAgent(agent.name)?.prMonitor).toBeUndefined();

  writeAgent({ ...agent, createdAt: "2026-02-01T00:00:00Z" });
  await expect(declarePullRequestReady(agent, url, home, { run: runner().run, reviewScript: script })).rejects.toThrow(/changed.*retry/);
  expect(readAgent(agent.name)?.prMonitor).toBeUndefined();
});

test("CLI readiness mode requires exactly one URL before any lookup", () => {
  owner();
  const cli = join(import.meta.dir, "../src/index.ts");
  for (const args of [["pr", "owner-agent", "--ready"], ["pr", "owner-agent", url, "https://github.com/owner/repo/pull/8", "--ready"]]) {
    const result = Bun.spawnSync([process.execPath, cli, ...args], { env: { ...process.env, AGENTMGR_SYSTEMD: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("requires exactly one PR URL");
  }
});

test("locked persistence refuses a newer terminal or replacement-head observation", async () => {
  for (const replacement of [
    { state: "MERGED" as const, headSha: head, mergeCommit: "e".repeat(40), mergedAt: "2026-01-05T00:00:00Z" },
    { state: "OPEN" as const, headSha: nextHead },
  ]) {
    const agent = owner();
    const baseRun = runner().run;
    let githubReads = 0;
    const run: PrCommand = async (cwd, executable, args) => {
      const result = await baseRun(cwd, executable, args);
      if (executable === "gh" && ++githubReads === 2) {
        recordPrObservations(readAgent(agent.name)!, [{ repository: "owner/repo", number: 7, url,
          mergeable: "MERGEABLE", updatedAt: "2026-01-05T00:00:00Z", ...replacement }]);
      }
      return result;
    };
    await expect(declarePullRequestReady(readAgent(agent.name)!, url, home, { run, reviewScript: script, notify: () => { throw new Error("must not notify"); } })).rejects.toThrow(/newer local PR state/);
    expect(readAgent(agent.name)!.prMonitor!.pullRequests[0]!.state).toBe(replacement.state);
    expect(readAgent(agent.name)!.prMonitor!.pullRequests[0]!.readyNotifiedHead).toBeUndefined();
    rmSync(process.env.AGENTMGR_HOME!, { recursive: true, force: true });
  }
});
