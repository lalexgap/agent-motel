import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { usageCommand } from "../src/commands/usage";
import { tryAcquireFileLock } from "../src/filelock";
import { agentsDir, usageLedgerFile } from "../src/paths";
import { startApiServer } from "../src/server";
import { writeAgent, type AgentState } from "../src/state";
import {
  readUsageLedger,
  refreshUsageLedger,
  repoForAgent,
  startUsageLedgerJob,
  usageSummary,
  type LedgerFileEntry,
} from "../src/usageLedger";

process.env.TZ = "UTC";

const NOW = new Date("2026-11-10T12:00:00.000Z");

let home: string;
let prevHome: string | undefined;
let prevCodexHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "am-usage-ledger-"));
  process.env.HOME = home;
  process.env.AGENTMGR_HOME = join(home, ".agent-manager");
  process.env.CODEX_HOME = join(home, ".codex");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  delete process.env.AGENTMGR_HOME;
});

interface UsageSpec {
  input?: number;
  output?: number;
  read?: number;
  write5m?: number;
  write1h?: number;
  // Only the legacy total, without the 5m/1h split.
  writeTotal?: number;
  fast?: boolean;
}

function assistant(
  id: string,
  timestamp: string,
  usage: UsageSpec,
  opts: { model?: string; sidechain?: boolean } = {},
): string {
  const write5m = usage.write5m ?? 0;
  const write1h = usage.write1h ?? 0;
  return JSON.stringify({
    type: "assistant",
    timestamp,
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: {
      id,
      model: opts.model ?? "claude-opus-5-5",
      content: [{ type: "text", text: "working" }],
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: usage.writeTotal ?? write5m + write1h,
        ...(usage.writeTotal === undefined
          ? { cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h } }
          : {}),
        ...(usage.fast ? { speed: "fast" } : {}),
      },
    },
  });
}

function compactBoundary(timestamp: string, preTokens: number): string {
  return JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp, compactMetadata: { preTokens } });
}

function projectDir(slug = "-work-repo"): string {
  const dir = join(home, ".claude", "projects", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(path: string, lines: string[]): void {
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
}

function claudeAgent(name: string, transcriptPath: string, extra: Partial<AgentState> = {}): AgentState {
  const agent: AgentState = {
    name,
    provider: "claude",
    status: "idle",
    dir: join(home, "code", "repo"),
    tmuxSession: `am-test-${name}`,
    transcriptPath,
    sessionId: "sess-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    ...extra,
  };
  writeAgent(agent);
  return agent;
}

function refreshAll(): void {
  for (let i = 0; i < 100; i++) {
    if (refreshUsageLedger({ budgetMs: 10_000, now: NOW }).pendingFiles === 0) return;
  }
  throw new Error("ledger did not converge");
}

function entryFor(path: string): LedgerFileEntry {
  const entry = readUsageLedger().files[path];
  if (!entry) throw new Error(`no ledger entry for ${path}`);
  return entry;
}

function comparable(entry: LedgerFileEntry): Omit<LedgerFileEntry, "mtimeMs"> {
  const { mtimeMs: _mtime, ...rest } = entry;
  return rest;
}

describe("usage ledger ingestion", () => {
  test("incremental parsing matches a single full parse", () => {
    const file = join(projectDir(), "sess-1.jsonl");
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-11-09T10:00:00.000Z", message: { role: "user", content: "go" } }),
      assistant("msg_a", "2026-11-09T10:00:01.000Z", { input: 10, write5m: 1000, output: 5 }),
      assistant("msg_a", "2026-11-09T10:00:01.000Z", { input: 10, write5m: 1000, output: 50 }),
      assistant("msg_b", "2026-11-09T10:01:00.000Z", { input: 20, read: 1000, write1h: 200, output: 70 }),
      compactBoundary("2026-11-09T10:02:00.000Z", 1200),
      assistant("msg_c", "2026-11-10T09:00:00.000Z", { input: 30, read: 500, output: 9 }),
      assistant("msg_c", "2026-11-10T09:00:00.000Z", { input: 30, read: 500, output: 90 }),
    ];
    const text = lines.map((l) => `${l}\n`).join("");
    // Cut between the two msg_a lines, in the middle of msg_b, and between the msg_c lines.
    const cutA = text.indexOf(lines[2]!);
    const cutB = text.indexOf(lines[3]!) + 40;
    const cutC = text.indexOf(lines[6]!);
    writeFileSync(file, text.slice(0, cutA));
    refreshAll();
    for (const [from, to] of [[cutA, cutB], [cutB, cutC], [cutC, text.length]] as const) {
      appendFileSync(file, text.slice(from, to));
      refreshAll();
    }
    const incremental = entryFor(file);

    rmSync(usageLedgerFile());
    refreshAll();
    const full = entryFor(file);

    expect(comparable(incremental)).toEqual(comparable(full));
    expect(full.offset).toBe(text.length);
    expect(full.days["2026-11-09"]!["claude-opus-5-5"]).toEqual([2, 30, 1000, 200, 1000, 120, 0]);
    expect(full.days["2026-11-10"]!["claude-opus-5-5"]).toEqual([1, 30, 0, 0, 500, 90, 0]);
    expect(full.context).toEqual({
      tokens: 530,
      peak: 1220,
      model: "claude-opus-5-5",
      at: "2026-11-10T09:00:00.000Z",
      compactions: 1,
    });
    expect(full.owner).toBeNull();
  });

  test("a repeated message id counts once with its last usage, even across refreshes", () => {
    const file = join(projectDir(), "sess-1.jsonl");
    writeTranscript(file, [assistant("msg_1", "2026-11-10T08:00:00.000Z", { input: 100, output: 1 })]);
    refreshAll();
    appendFileSync(file, `${assistant("msg_1", "2026-11-10T08:00:00.000Z", { input: 100, output: 400 })}\n`);
    refreshAll();
    const entry = entryFor(file);
    expect(entry.days["2026-11-10"]).toEqual({ "claude-opus-5-5": [1, 100, 0, 0, 0, 400, 0] });
    expect(entry.tail.map((t) => t.id)).toEqual(["msg_1"]);
  });

  test("splits cache writes by TTL and buckets fast calls separately", () => {
    const file = join(projectDir(), "sess-1.jsonl");
    writeTranscript(file, [
      assistant("m1", "2026-11-10T08:00:00.000Z", { input: 1, write5m: 300, write1h: 700, output: 2 }),
      assistant("m2", "2026-11-10T08:01:00.000Z", { input: 1, write5m: 10, output: 2, fast: true }),
      assistant("m3", "2026-11-10T08:02:00.000Z", { input: 1, writeTotal: 55, output: 2 }),
    ]);
    refreshAll();
    expect(entryFor(file).days["2026-11-10"]).toEqual({
      "claude-opus-5-5": [2, 2, 355, 700, 0, 4, 0],
      "claude-opus-5-5|fast": [1, 1, 10, 0, 0, 2, 0],
    });
  });

  test("buckets haiku 5.5 calls over 100K prompt tokens into the long tier", () => {
    const file = join(projectDir(), "sess-1.jsonl");
    writeTranscript(file, [
      assistant("m1", "2026-11-10T08:00:00.000Z", { input: 10, read: 100_000, output: 1 }, { model: "claude-haiku-5-5" }),
      assistant("m2", "2026-11-10T08:01:00.000Z", { input: 10, read: 1000, output: 1 }, { model: "claude-haiku-5-5-20261001" }),
    ]);
    refreshAll();
    expect(Object.keys(entryFor(file).days["2026-11-10"]!).sort()).toEqual(["claude-haiku-5-5", "claude-haiku-5-5|long"]);
  });

  test("calls on different days land in different day buckets", () => {
    const file = join(projectDir(), "sess-1.jsonl");
    writeTranscript(file, [
      assistant("m1", "2026-11-08T23:59:59.000Z", { input: 1, output: 1 }),
      assistant("m2", "2026-11-09T00:00:01.000Z", { input: 2, output: 2 }),
    ]);
    refreshAll();
    const days = entryFor(file).days;
    expect(Object.keys(days).sort()).toEqual(["2026-11-08", "2026-11-09"]);
    expect(days["2026-11-09"]!["claude-opus-5-5"]![1]).toBe(2);
  });

  test("attributes subagent transcripts to the parent and skips sidechain lines in the main file", () => {
    const dir = projectDir();
    const main = join(dir, "sess-1.jsonl");
    writeTranscript(main, [
      assistant("main_1", "2026-11-10T08:00:00.000Z", { input: 100_000, output: 10_000 }),
      assistant("side_1", "2026-11-10T08:00:30.000Z", { input: 999_999, output: 999 }, { sidechain: true }),
    ]);
    const subDir = join(dir, "sess-1", "subagents");
    mkdirSync(subDir, { recursive: true });
    const sub = join(subDir, "agent-abc.jsonl");
    writeTranscript(sub, [assistant("side_1", "2026-11-10T08:00:30.000Z", { input: 40_000, output: 4_000 }, { sidechain: true })]);
    writeFileSync(join(subDir, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", description: "look" }));
    claudeAgent("alpha", main, { repoRoot: join(home, "code", "agent-motel") });
    refreshAll();

    expect(entryFor(main).owner).toMatchObject({ agent: "alpha", kind: "main", repo: "agent-motel" });
    expect(entryFor(main).days["2026-11-10"]!["claude-opus-5-5"]).toEqual([1, 100_000, 0, 0, 0, 10_000, 0]);
    expect(entryFor(sub).owner).toMatchObject({ agent: "alpha", kind: "subagent", subagentId: "abc", subagentType: "Explore" });
    expect(entryFor(sub).context).toBeUndefined();

    const summary = usageSummary({ range: 1, now: NOW });
    expect(summary.agents).toHaveLength(1);
    const alpha = summary.agents[0]!;
    expect(alpha.subagents).toBe(1);
    expect(alpha.range.activeTokens).toBe(110_000 + 44_000);
    expect(alpha.subagentCostUSD).toBe(0.24);
    expect(alpha.mainCostUSD).toBe(0.6);
    expect(summary.unattributed.range.calls).toBe(0);
  });

  test("keeps a removed agent's usage, and a deleted transcript's", () => {
    const main = join(projectDir(), "sess-1.jsonl");
    writeTranscript(main, [assistant("m1", "2026-11-10T08:00:00.000Z", { input: 1000, output: 100 })]);
    claudeAgent("alpha", main);
    refreshAll();
    expect(usageSummary({ range: 7, now: NOW }).agents[0]).toMatchObject({ name: "alpha", live: false });

    rmSync(join(agentsDir(), "alpha.json"));
    refreshAll();
    let summary = usageSummary({ range: 7, now: NOW });
    expect(summary.agents).toHaveLength(1);
    expect(summary.agents[0]).toMatchObject({ name: "alpha", status: "removed", live: false });
    expect(summary.unattributed.range.calls).toBe(0);

    rmSync(main);
    refreshAll();
    summary = usageSummary({ range: 7, now: NOW });
    expect(summary.agents[0]).toMatchObject({ name: "alpha", status: "removed" });
    expect(summary.agents[0]!.range.activeTokens).toBe(1100);
  });

  test("a recreated agent with the same name is a separate agent", () => {
    const dir = projectDir();
    const first = join(dir, "sess-1.jsonl");
    writeTranscript(first, [assistant("m1", "2026-11-10T08:00:00.000Z", { input: 1000, output: 100 })]);
    claudeAgent("alpha", first);
    refreshAll();
    const second = join(dir, "sess-2.jsonl");
    writeTranscript(second, [assistant("m2", "2026-11-10T09:00:00.000Z", { input: 10, output: 1 })]);
    claudeAgent("alpha", second, { sessionId: "sess-2", createdAt: "2026-11-10T08:30:00.000Z" });
    refreshAll();
    const rows = usageSummary({ range: 1, now: NOW }).agents;
    expect(rows.map((r) => [r.name, r.status === "removed"])).toEqual([
      ["alpha", true],
      ["alpha", false],
    ]);
  });

  test("an unowned Claude transcript is unattributed", () => {
    const file = join(projectDir("-somewhere-else"), "loose.jsonl");
    writeTranscript(file, [assistant("m1", "2026-11-10T08:00:00.000Z", { input: 500, output: 50 })]);
    refreshAll();
    const summary = usageSummary({ range: 1, now: NOW });
    expect(summary.agents).toHaveLength(0);
    expect(summary.unattributed.range).toMatchObject({ calls: 1, activeTokens: 550 });
    expect(summary.unattributed.dailyActiveTokens.at(-1)).toBe(550);
    expect(summary.totals.today.activeTokens).toBe(550);
  });

  test("a truncated or rewritten file is re-parsed from zero", () => {
    const file = join(projectDir(), "sess-1.jsonl");
    writeTranscript(file, [
      assistant("m1", "2026-11-10T08:00:00.000Z", { input: 1000, output: 100 }),
      assistant("m2", "2026-11-10T08:01:00.000Z", { input: 2000, output: 200 }),
    ]);
    refreshAll();
    writeTranscript(file, [assistant("m9", "2026-11-10T09:00:00.000Z", { input: 7, output: 3 })]);
    refreshAll();
    expect(entryFor(file).days).toEqual({ "2026-11-10": { "claude-opus-5-5": [1, 7, 0, 0, 0, 3, 0] } });
    expect(entryFor(file).tail.map((t) => t.id)).toEqual(["m9"]);
  });

  test("a zero budget processes one file per call and converges to an unbudgeted run", () => {
    const dir = projectDir();
    for (const [i, name] of ["a", "b", "c"].entries()) {
      writeTranscript(join(dir, `${name}.jsonl`), [
        assistant(`m_${name}`, "2026-11-10T08:00:00.000Z", { input: 10 * (i + 1), output: i + 1 }),
      ]);
    }
    expect(refreshUsageLedger({ budgetMs: 0, now: NOW }).pendingFiles).toBe(2);
    expect(Object.keys(readUsageLedger().files)).toHaveLength(1);
    expect(readUsageLedger().pendingFiles).toBe(2);
    expect(refreshUsageLedger({ budgetMs: 0, now: NOW }).pendingFiles).toBe(1);
    expect(refreshUsageLedger({ budgetMs: 0, now: NOW }).pendingFiles).toBe(0);
    const budgeted = readUsageLedger().files;

    rmSync(usageLedgerFile());
    refreshUsageLedger({ now: NOW });
    const unbudgeted = readUsageLedger().files;
    const strip = (files: Record<string, LedgerFileEntry>) =>
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, comparable(v)]));
    expect(strip(budgeted)).toEqual(strip(unbudgeted));
  });

  test("a large file is consumed in chunks across budgeted slices", () => {
    const file = join(projectDir(), "big.jsonl");
    const filler = JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(9 * 1024 * 1024) } });
    writeTranscript(file, [
      assistant("m1", "2026-11-10T08:00:00.000Z", { input: 1, output: 1 }),
      filler,
      assistant("m2", "2026-11-10T08:01:00.000Z", { input: 2, output: 2 }),
    ]);
    expect(refreshUsageLedger({ budgetMs: 0, now: NOW }).pendingFiles).toBe(1);
    const partial = entryFor(file);
    expect(partial.days["2026-11-10"]!["claude-opus-5-5"]![0]).toBe(1);
    expect(partial.offset).toBeGreaterThan(0);
    expect(partial.size).toBe(-1);
    expect(refreshUsageLedger({ budgetMs: 0, now: NOW }).pendingFiles).toBe(0);
    expect(entryFor(file).days["2026-11-10"]!["claude-opus-5-5"]).toEqual([2, 3, 0, 0, 0, 3, 0]);
  });

  test("am usage --summary backfills and prints JSON", async () => {
    writeTranscript(join(projectDir(), "a.jsonl"), [assistant("m1", new Date().toISOString(), { input: 1_000_000, output: 0 })]);
    const out: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    try {
      await usageCommand({ summary: true, json: true, days: 1 });
      await usageCommand({ summary: true, days: 30 });
    } finally {
      console.log = log;
    }
    const summary = JSON.parse(out[0]!);
    expect(summary.totals.today.costUSD).toBe(4);
    expect(summary.unattributed.range.calls).toBe(1);
    expect(out[1]).toContain("today $4.00");
    await expect(usageCommand({ summary: true, days: 5 })).rejects.toThrow("--days must be 1, 7, or 30");
    expect(parseArgs(["usage", "--summary", "--days", "30"]).flags).toEqual({ summary: true, days: "30" });
  });

  test("returns without writing when another process holds the lock", () => {
    writeTranscript(join(projectDir(), "a.jsonl"), [assistant("m1", "2026-11-10T08:00:00.000Z", { input: 1, output: 1 })]);
    const release = tryAcquireFileLock(`${usageLedgerFile()}.lock`)!;
    try {
      expect(refreshUsageLedger({ now: NOW })).toEqual({ changed: false, pendingFiles: 0, skipped: true });
      expect(existsSync(usageLedgerFile())).toBe(false);
    } finally {
      release();
    }
    expect(refreshUsageLedger({ now: NOW }).changed).toBe(true);
  });

  test("derives the repo from repoRoot, a worktree path, or the directory", () => {
    expect(repoForAgent({ repoRoot: "/src/agent-motel", dir: "/x" })).toBe("agent-motel");
    expect(repoForAgent({ dir: "/h/.agent-manager/worktrees/producthunt/fix-ads/web" })).toBe("producthunt");
    expect(repoForAgent({ dir: "/h/code/thing/" })).toBe("thing");
    expect(repoForAgent({ dir: home })).toBe("~");
  });
});

describe("usage summary", () => {
  function seedFleet(): void {
    const dir = projectDir();
    const alphaFile = join(dir, "sess-a.jsonl");
    writeTranscript(alphaFile, [
      assistant("a_old", "2026-11-01T08:00:00.000Z", { input: 1_000_000, output: 0 }),
      assistant("a_today", "2026-11-10T08:00:00.000Z", { input: 1000, read: 249_000, output: 100 }),
    ]);
    claudeAgent("alpha", alphaFile, { sessionId: "sess-a", repoRoot: join(home, "code", "one") });

    const betaFile = join(dir, "sess-b.jsonl");
    writeTranscript(betaFile, [
      assistant("b_today", "2026-11-10T09:00:00.000Z", { input: 500, write1h: 1000, output: 100 }, { model: "claude-sonnet-4-6" }),
    ]);
    claudeAgent("beta", betaFile, { sessionId: "sess-b", repoRoot: join(home, "code", "two") });

    const sessionId = "019a0000-0000-7000-8000-000000000001";
    const rolloutDir = join(home, ".codex", "sessions", "2026", "11", "10");
    mkdirSync(rolloutDir, { recursive: true });
    const rollout = join(rolloutDir, `rollout-2026-11-10T07-00-00-${sessionId}.jsonl`);
    writeTranscript(rollout, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-10T07:00:00.000Z", payload: { model: "gpt-5.5-codex" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-11-10T07:00:05.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 3000 },
            last_token_usage: { input_tokens: 2500, cached_input_tokens: 500, output_tokens: 500 },
          },
        },
      }),
    ]);
    writeAgent({
      name: "gamma",
      provider: "codex",
      status: "idle",
      dir: join(home, "code", "two"),
      tmuxSession: "am-test-gamma",
      sessionId,
      createdAt: "2026-11-02T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
    });
    refreshAll();
  }

  test("ranges, filters, context, unpriced tokens, and sort order", () => {
    seedFleet();
    const week = usageSummary({ range: 7, now: NOW });
    expect(week.days).toHaveLength(30);
    expect(week.days.at(-1)).toBe("2026-11-10");
    expect(week.days[0]).toBe("2026-10-12");
    expect(week.filters).toEqual({ repos: ["one", "two"], providers: ["claude", "codex"] });

    // alpha: today's call only in the 7d range; its 11-01 call is in the 30d one.
    const alphaToday = (1000 * 4 + 249_000 * 0.2 + 100 * 20) / 1e6;
    const betaToday = (500 * 3 + 1000 * 6 + 100 * 15) / 1e6;
    expect(week.totals.today.costUSD).toBeCloseTo(alphaToday + betaToday, 4);
    expect(week.totals.last30.costUSD).toBeCloseTo(alphaToday + betaToday + 4, 4);
    expect(week.totals.today.unpricedActiveTokens).toBe(2500);
    expect(week.totals.today.calls).toBe(3);

    expect(week.agents.map((a) => a.name)).toEqual(["alpha", "beta", "gamma"]);
    const [alpha, beta, gamma] = week.agents;
    expect(alpha!.context).toEqual({ tokens: 250_000, window: 1_000_000, pct: 25, peak: 1_000_000, compactions: 0 });
    expect(alpha!.cacheHitRate).toBeCloseTo(249_000 / 250_000, 4);
    expect(beta!.cacheWriteShare).toBeCloseTo((1000 * 6) / (500 * 3 + 1000 * 6 + 100 * 15), 4);
    expect(gamma!).toMatchObject({ provider: "codex", repo: "two", model: "gpt-5.5-codex" });
    expect(gamma!.range).toMatchObject({ costUSD: 0, unpricedActiveTokens: 2500, activeTokens: 2500, cacheReadTokens: 500 });
    expect(gamma!.cacheWriteShare).toBeNull();
    expect(gamma!.context).toMatchObject({ tokens: 2500, window: null, pct: null });
    expect(alpha!.dailyCostUSD).toHaveLength(30);
    expect(alpha!.dailyCostUSD[30 - 10]).toBeCloseTo(4, 4);

    expect(week.byModel.map((m) => [m.model, m.priced])).toEqual([
      ["claude-opus-5-5", true],
      ["claude-sonnet-4-6", true],
      ["gpt-5.5-codex", false],
    ]);
    expect(week.byRepo.map((r) => [r.repo, r.agents])).toEqual([
      ["one", 1],
      ["two", 2],
    ]);
    expect(week.classes.cacheWrite1h).toEqual({ costUSD: 0.006, tokens: 1000 });

    const month = usageSummary({ range: 30, now: NOW });
    expect(month.agents[0]!.range.costUSD).toBeCloseTo(alphaToday + 4, 4);

    const repoTwo = usageSummary({ range: 7, repo: "two", now: NOW });
    expect(repoTwo.agents.map((a) => a.name)).toEqual(["beta", "gamma"]);
    expect(repoTwo.totals.last30.costUSD).toBeCloseTo(betaToday, 4);
    expect(repoTwo.filters.repos).toEqual(["one", "two"]);

    const codexOnly = usageSummary({ range: 1, provider: "codex", now: NOW });
    expect(codexOnly.agents.map((a) => a.name)).toEqual(["gamma"]);
    expect(codexOnly.totals.today).toMatchObject({ costUSD: 0, unpricedActiveTokens: 2500 });
  });

  test("GET /api/usage/summary answers with the stored summary and validates inputs", async () => {
    seedFleet();
    const server = startApiServer({ port: 0, hostname: "127.0.0.1", token: "test-token" });
    try {
      const headers = { Authorization: "Bearer test-token" };
      const ok = await fetch(`${server.url}/api/usage/summary?range=30&quota=0`, { headers });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as any;
      expect(body.quota).toBeUndefined();
      expect(body.summary.days).toHaveLength(30);
      expect(body.summary.agents.map((a: any) => a.name).sort()).toEqual(["alpha", "beta", "gamma"]);

      const filtered = await fetch(`${server.url}/api/usage/summary?range=1&provider=codex&quota=0`, { headers });
      expect(((await filtered.json()) as any).summary.agents.map((a: any) => a.name)).toEqual(["gamma"]);

      for (const query of ["range=5", "range=abc", "range=7&provider=gpt"]) {
        const bad = await fetch(`${server.url}/api/usage/summary?${query}&quota=0`, { headers });
        expect(bad.status).toBe(400);
      }

      // The plain usage endpoint is untouched.
      const plain = await fetch(`${server.url}/api/usage?quota=0`, { headers });
      expect(plain.status).toBe(200);
      expect(((await plain.json()) as any).tokens).toBeDefined();
    } finally {
      server.stop();
    }
  });
});

describe("usage ledger daemon job", () => {
  test("re-runs quickly while files are pending, then waits the full interval", async () => {
    const pending = [2, 1, 0, 0];
    let calls = 0;
    const job = startUsageLedgerJob({
      log: () => {},
      firstDelayMs: 5,
      backfillDelayMs: 5,
      intervalMs: 60_000,
      refresh: () => ({ changed: true, pendingFiles: pending[calls++] ?? 0 }),
    });
    try {
      await Bun.sleep(150);
    } finally {
      job.stop();
    }
    expect(calls).toBe(3);
  });

  test("logs a failed slice and keeps the schedule", async () => {
    const logs: string[] = [];
    const budgets: number[] = [];
    const job = startUsageLedgerJob({
      log: (m) => logs.push(m),
      firstDelayMs: 5,
      intervalMs: 20,
      refresh: ({ budgetMs }) => {
        budgets.push(budgetMs);
        if (budgets.length === 1) throw new Error("boom");
        return { changed: false, pendingFiles: 0 };
      },
    });
    try {
      await Bun.sleep(60);
    } finally {
      job.stop();
    }
    expect(logs).toEqual(["usage ledger refresh failed: Error: boom"]);
    expect(budgets.length).toBeGreaterThanOrEqual(2);
    expect(budgets[0]).toBe(1000);
    const after = budgets.length;
    await Bun.sleep(60);
    expect(budgets.length).toBe(after);
  });
});
