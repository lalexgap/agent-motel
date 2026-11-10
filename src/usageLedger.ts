import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { codexHome } from "./codexHooks";
import { displayStatus } from "./commands/ls";
import { localHostIdentity } from "./config";
import { tryAcquireFileLock } from "./filelock";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { claudeProjectsDir, usageDir, usageLedgerFile } from "./paths";
import {
  bucketKey,
  contextWindowFor,
  costBreakdown,
  COUNT_CALLS,
  COUNT_FIELDS,
  COUNT_INPUT,
  COUNT_OUTPUT,
  COUNT_READ,
  COUNT_WRITE_1H,
  COUNT_WRITE_5M,
  isLongPrompt,
  parseBucketKey,
  priceFor,
  type UsageCounts,
} from "./pricing";
import { roleForAgent } from "./roles";
import { agentProvider, agentSessionId, listAgents, type AgentState, type Provider } from "./state";
import { readSubagents } from "./subagents";
import {
  antigravityBrainTranscriptPath,
  buildCodexRolloutIndex,
  discoverExtraClaudeSubagents,
  locateAntigravityBrainTranscript,
  parseAntigravitySteps,
  parseClaudeSteps,
  parseCodexSteps,
  stepHasTokens,
  type StepEvent,
} from "./tokenUsage";
import { locateTranscript } from "./transcript";

export interface LedgerOwner {
  agent: string;
  agentCreatedAt?: string;
  repo?: string;
  role?: string;
  kind: "main" | "subagent";
  subagentId?: string;
  subagentType?: string;
  sessionId?: string;
}

export interface LedgerTailItem {
  id: string;
  day: string;
  key: string;
  counts: UsageCounts;
}

export interface LedgerContext {
  tokens: number;
  peak: number;
  model?: string;
  at?: string;
  compactions: number;
}

// counts: [calls, input, cacheWrite5m, cacheWrite1h, cacheRead, output, thinking]
export interface LedgerFileEntry {
  provider: Provider;
  // null = a Claude session not tied to any am agent.
  owner: LedgerOwner | null;
  size: number;
  mtimeMs: number;
  // Bytes already consumed; always just after a "\n".
  offset: number;
  // Last counted assistant message ids, so a repeated id replaces its earlier usage.
  tail: LedgerTailItem[];
  context?: LedgerContext;
  days: Record<string, Record<string, UsageCounts>>;
  firstAt?: string;
  lastAt?: string;
  // Antigravity main files: subagent transcripts announced in the conversation.
  subagentFiles?: Array<{ id: string; path: string; type?: string }>;
}

export interface UsageLedger {
  version: 1;
  refreshedAt?: string;
  pendingFiles: number;
  files: Record<string, LedgerFileEntry>;
}

const TAIL_MAX = 64;
const CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 1000;
const CODEX_INDEX_TTL_MS = 5 * 60_000;
const CODEX_INDEX_MISS_REBUILD_MS = 10_000;

export function emptyLedger(): UsageLedger {
  return { version: 1, pendingFiles: 0, files: {} };
}

export function readUsageLedger(): UsageLedger {
  const doc = readJsonOrNull<UsageLedger>(usageLedgerFile());
  if (!doc || doc.version !== 1 || !doc.files || typeof doc.files !== "object") return emptyLedger();
  return { ...doc, pendingFiles: Number(doc.pendingFiles) || 0 };
}

export function ledgerAgeMs(ledger: UsageLedger, now = Date.now()): number {
  const at = ledger.refreshedAt ? Date.parse(ledger.refreshedAt) : NaN;
  return Number.isFinite(at) ? now - at : Infinity;
}

export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayOf(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? localDay(new Date(ms)) : undefined;
}

function zeroCounts(): UsageCounts {
  return new Array(COUNT_FIELDS).fill(0);
}

function addCounts(target: UsageCounts, source: UsageCounts, sign = 1): void {
  for (let i = 0; i < COUNT_FIELDS; i++) target[i] = (target[i] ?? 0) + sign * (source[i] ?? 0);
}

function isZero(counts: UsageCounts): boolean {
  return counts.every((n) => !n);
}

function stepCounts(step: StepEvent): UsageCounts {
  const write5m = step.cacheCreation5mTokens ?? step.cacheCreationTokens;
  const write1h = step.cacheCreation1hTokens ?? 0;
  return [1, step.inputTokens, write5m, write1h, step.cacheReadTokens, step.outputTokens, step.thinkingTokens];
}

function stepKey(step: StepEvent): string {
  const prompt =
    step.inputTokens + step.cacheReadTokens + (step.cacheCreation5mTokens ?? step.cacheCreationTokens) + (step.cacheCreation1hTokens ?? 0);
  return bucketKey(step.model, { fast: step.fast === true, long: isLongPrompt(step.model, prompt) });
}

function bucketAdd(entry: LedgerFileEntry, day: string, key: string, counts: UsageCounts, sign: number): void {
  const byKey = (entry.days[day] ??= {});
  const current = (byKey[key] ??= zeroCounts());
  addCounts(current, counts, sign);
  if (isZero(current)) delete byKey[key];
  if (Object.keys(byKey).length === 0) delete entry.days[day];
}

function earlier(a: string | undefined, b: string): string {
  return !a || Date.parse(b) < Date.parse(a) ? b : a;
}

function later(a: string | undefined, b: string): string {
  return !a || Date.parse(b) >= Date.parse(a) ? b : a;
}

function applyStep(entry: LedgerFileEntry, step: StepEvent, fallbackDay: string, isMain: boolean): void {
  const counted = stepHasTokens(step);
  const id = step.messageId;
  const prevIndex = id ? entry.tail.findIndex((t) => t.id === id) : -1;
  if (prevIndex < 0 && !counted) return;
  const day = dayOf(step.timestamp) ?? fallbackDay;
  const key = stepKey(step);
  const counts = counted ? stepCounts(step) : zeroCounts();
  if (prevIndex >= 0) {
    const prev = entry.tail[prevIndex]!;
    bucketAdd(entry, prev.day, prev.key, prev.counts, -1);
    entry.tail.splice(prevIndex, 1);
  }
  if (counted) bucketAdd(entry, day, key, counts, 1);
  if (id) {
    entry.tail.push({ id, day, key, counts });
    if (entry.tail.length > TAIL_MAX) entry.tail.splice(0, entry.tail.length - TAIL_MAX);
  }
  if (!counted) return;
  if (step.timestamp && Number.isFinite(Date.parse(step.timestamp))) {
    entry.firstAt = earlier(entry.firstAt, step.timestamp);
    entry.lastAt = later(entry.lastAt, step.timestamp);
  }
  if (isMain) {
    const tokens = step.inputTokens + step.cacheReadTokens + step.cacheCreationTokens;
    const ctx = (entry.context ??= { tokens: 0, peak: 0, compactions: 0 });
    ctx.tokens = tokens;
    ctx.peak = Math.max(ctx.peak, tokens);
    if (step.model) ctx.model = step.model;
    if (step.timestamp) ctx.at = step.timestamp;
  }
}

function resetEntry(entry: LedgerFileEntry): void {
  entry.offset = 0;
  entry.tail = [];
  entry.days = {};
  delete entry.context;
  delete entry.firstAt;
  delete entry.lastAt;
  delete entry.subagentFiles;
}

interface FileTask {
  path: string;
  provider: Provider;
  owner: LedgerOwner | null;
  isMain: boolean;
  tier: number;
  size: number;
  mtimeMs: number;
}

function fileStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

function readBytes(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read < length ? buf.subarray(0, read) : buf;
}

// Claude transcripts are append-only: consume complete lines from `offset`.
// Returns false when the deadline cut the file short.
function processClaudeFile(entry: LedgerFileEntry, task: FileTask, deadline: number): boolean {
  const fd = openSync(task.path, "r");
  try {
    if (task.size < entry.offset) resetEntry(entry);
    else if (entry.offset > 0 && readBytes(fd, entry.offset - 1, 1)[0] !== 10) resetEntry(entry);
    const fallbackDay = localDay(new Date(task.mtimeMs));
    let pos = entry.offset;
    while (pos < task.size) {
      let length = Math.min(CHUNK_BYTES, task.size - pos);
      let buf: Buffer;
      let newline: number;
      for (;;) {
        buf = readBytes(fd, pos, length);
        newline = buf.lastIndexOf(10);
        if (newline >= 0 || pos + length >= task.size) break;
        length = Math.min(length * 2, task.size - pos);
      }
      if (newline < 0) break;
      const text = buf.subarray(0, newline + 1).toString("utf8");
      const parsed = parseClaudeSteps(text, { ownFile: !task.isMain });
      for (const step of parsed.steps) applyStep(entry, step, fallbackDay, task.isMain);
      if (task.isMain && parsed.compactions.length > 0) {
        const ctx = (entry.context ??= { tokens: 0, peak: 0, compactions: 0 });
        ctx.compactions += parsed.compactions.length;
      }
      pos += newline + 1;
      entry.offset = pos;
      if (Date.now() >= deadline && pos < task.size) return false;
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

function processWholeFile(entry: LedgerFileEntry, task: FileTask): void {
  resetEntry(entry);
  const text = readFileSync(task.path, "utf8");
  const fallbackDay = localDay(new Date(task.mtimeMs));
  let steps: StepEvent[];
  if (task.provider === "codex") {
    steps = parseCodexSteps(text).steps;
  } else {
    const parsed = parseAntigravitySteps(text);
    steps = parsed.steps;
    if (task.isMain && parsed.antigravitySubagents.length > 0) {
      entry.subagentFiles = parsed.antigravitySubagents
        .filter((r) => r.transcriptPath)
        .map((r) => ({ id: r.id, path: r.transcriptPath!, ...(r.type ? { type: r.type } : {}) }));
    }
  }
  for (const step of steps) applyStep(entry, step, fallbackDay, task.isMain);
  entry.offset = task.size;
}

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

export function repoForAgent(agent: Pick<AgentState, "repoRoot" | "dir">): string {
  if (agent.repoRoot) return basename(agent.repoRoot);
  const worktree = /\/worktrees\/([^/]+)\/[^/]+(?:\/|$)/.exec(agent.dir);
  if (worktree?.[1]) return worktree[1];
  const dir = agent.dir.replace(/\/+$/, "");
  if (dir === homeDir().replace(/\/+$/, "")) return "~";
  return basename(dir) || dir;
}

let codexIndexCache: { home: string; at: number; index: Map<string, string> } | null = null;

function codexRollout(sessionId: string): string | undefined {
  const home = codexHome();
  const age = codexIndexCache && codexIndexCache.home === home ? Date.now() - codexIndexCache.at : Infinity;
  const cached = age < CODEX_INDEX_TTL_MS ? codexIndexCache!.index.get(sessionId) : undefined;
  if (cached && existsSync(cached)) return cached;
  // A miss rebuilds at most every few seconds, so agents without a rollout don't walk the tree each pass.
  if (age >= CODEX_INDEX_MISS_REBUILD_MS) codexIndexCache = { home, at: Date.now(), index: buildCodexRolloutIndex() };
  return codexIndexCache?.home === home ? codexIndexCache.index.get(sessionId) : undefined;
}

const mainTranscriptCache = new Map<string, string>();

function mainTranscriptFor(agent: AgentState, provider: Provider): string | null {
  if (provider === "antigravity") return locateAntigravityBrainTranscript(agent);
  if (provider === "codex") {
    const sessionId = agentSessionId(agent);
    return sessionId ? (codexRollout(sessionId) ?? null) : null;
  }
  const cacheKey = [agent.name, agent.createdAt, agentSessionId(agent), agent.transcriptPath, agent.dir].join("|");
  const cached = mainTranscriptCache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;
  try {
    const file = locateTranscript(agent);
    mainTranscriptCache.set(cacheKey, file);
    return file;
  } catch {
    return null;
  }
}

function ownedTasks(agent: AgentState, previous: UsageLedger): Array<Omit<FileTask, "tier" | "size" | "mtimeMs">> {
  const provider = agentProvider(agent);
  const base = {
    agent: agent.name,
    ...(agent.createdAt ? { agentCreatedAt: agent.createdAt } : {}),
    repo: repoForAgent(agent),
    ...(roleForAgent(agent) ? { role: roleForAgent(agent) } : {}),
    ...(agentSessionId(agent) ? { sessionId: agentSessionId(agent) } : {}),
  };
  const tasks: Array<Omit<FileTask, "tier" | "size" | "mtimeMs">> = [];
  const main = mainTranscriptFor(agent, provider);
  if (main) tasks.push({ path: main, provider, owner: { ...base, kind: "main" }, isMain: true });

  const records = readSubagents(agent.name);
  const subs: Array<{ id: string; type?: string; path: string | null }> = [];
  for (const record of records) {
    let path: string | null = record.transcriptPath && existsSync(record.transcriptPath) ? record.transcriptPath : null;
    if (!path && provider === "claude" && main) {
      path = join(dirname(main), basename(main, ".jsonl"), "subagents", `agent-${record.id}.jsonl`);
    } else if (!path && provider === "codex") {
      path = codexRollout(record.id) ?? null;
    } else if (!path && provider === "antigravity") {
      path = antigravityBrainTranscriptPath(record.id);
    }
    subs.push({ id: record.id, type: record.type, path });
  }
  const known = new Set(records.map((r) => r.id));
  if (provider === "claude") {
    for (const extra of discoverExtraClaudeSubagents(main, known)) {
      subs.push({ id: extra.id, type: extra.type, path: extra.transcriptPath ?? null });
    }
  } else if (provider === "antigravity" && main) {
    for (const sub of previous.files[main]?.subagentFiles ?? []) {
      if (!known.has(sub.id)) subs.push({ id: sub.id, type: sub.type, path: sub.path });
    }
  }
  for (const sub of subs) {
    if (!sub.path || sub.path === main) continue;
    tasks.push({
      path: sub.path,
      provider,
      owner: { ...base, kind: "subagent", subagentId: sub.id, ...(sub.type ? { subagentType: sub.type } : {}) },
      isMain: false,
    });
  }
  return tasks;
}

function unownedClaudeFiles(): Array<{ path: string; isMain: boolean }> {
  const root = claudeProjectsDir();
  const out: Array<{ path: string; isMain: boolean }> = [];
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const slugDir = join(root, slug);
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of names) {
      if (item.isFile() && item.name.endsWith(".jsonl")) {
        out.push({ path: join(slugDir, item.name), isMain: true });
      } else if (item.isDirectory()) {
        const subDir = join(slugDir, item.name, "subagents");
        let subNames: string[];
        try {
          subNames = readdirSync(subDir);
        } catch {
          continue;
        }
        for (const name of subNames) {
          if (/^agent-.+\.jsonl$/.test(name)) out.push({ path: join(subDir, name), isMain: false });
        }
      }
    }
  }
  return out;
}

function sameOwner(a: LedgerOwner | null, b: LedgerOwner | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface RefreshResult {
  changed: boolean;
  pendingFiles: number;
  // Another process held the ledger lock; nothing was read or written.
  skipped?: boolean;
}

// One bounded indexing slice: discover transcripts, ingest what changed since
// the last pass, persist. Returns without work when another process holds the lock.
export function refreshUsageLedger(opts: { budgetMs?: number; now?: Date } = {}): RefreshResult {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const start = Date.now();
  const deadline = start + budgetMs;
  mkdirSync(usageDir(), { recursive: true });
  const release = tryAcquireFileLock(`${usageLedgerFile()}.lock`);
  if (!release) return { changed: false, pendingFiles: readUsageLedger().pendingFiles, skipped: true };
  try {
    const ledger = readUsageLedger();
    let changed = false;

    const tasks: FileTask[] = [];
    const seen = new Set<string>();
    const agents = listAgents();
    for (const agent of agents) {
      const tier = agent.status !== "exited" ? 0 : 1;
      let owned: ReturnType<typeof ownedTasks>;
      try {
        owned = ownedTasks(agent, ledger);
      } catch {
        continue;
      }
      for (const task of owned) {
        if (seen.has(task.path)) continue;
        const stat = fileStat(task.path);
        if (!stat) continue;
        seen.add(task.path);
        tasks.push({ ...task, tier, ...stat });
      }
    }
    const unowned: FileTask[] = [];
    for (const file of unownedClaudeFiles()) {
      if (seen.has(file.path)) continue;
      const stat = fileStat(file.path);
      if (!stat) continue;
      seen.add(file.path);
      const existing = ledger.files[file.path];
      unowned.push({
        path: file.path,
        provider: existing?.provider ?? "claude",
        owner: existing?.owner ?? null,
        isMain: existing?.owner ? existing.owner.kind === "main" : file.isMain,
        tier: 2,
        ...stat,
      });
    }
    unowned.sort((a, b) => b.mtimeMs - a.mtimeMs);
    tasks.sort((a, b) => a.tier - b.tier);
    tasks.push(...unowned);

    let pendingFiles = 0;
    let processed = 0;
    for (const task of tasks) {
      let entry = ledger.files[task.path];
      if (!entry) {
        if (processed > 0 && Date.now() >= deadline) {
          pendingFiles++;
          continue;
        }
        entry = { provider: task.provider, owner: task.owner, size: -1, mtimeMs: -1, offset: 0, tail: [], days: {} };
        ledger.files[task.path] = entry;
        changed = true;
      }
      if (task.tier < 2 && !sameOwner(entry.owner, task.owner)) {
        entry.owner = task.owner;
        changed = true;
      }
      if (entry.provider !== task.provider) {
        entry.provider = task.provider;
        resetEntry(entry);
        entry.size = -1;
        changed = true;
      }
      if (entry.size === task.size && entry.mtimeMs === task.mtimeMs) continue;
      if (processed > 0 && Date.now() >= deadline) {
        pendingFiles++;
        continue;
      }
      processed++;
      changed = true;
      try {
        let complete = true;
        if (task.provider === "claude") complete = processClaudeFile(entry, task, deadline);
        else processWholeFile(entry, task);
        if (complete) {
          entry.size = task.size;
          entry.mtimeMs = task.mtimeMs;
        } else {
          pendingFiles++;
        }
      } catch {
        // Unreadable now; retried when its size or mtime changes.
        entry.size = task.size;
        entry.mtimeMs = task.mtimeMs;
      }
    }

    ledger.pendingFiles = pendingFiles;
    ledger.refreshedAt = (opts.now ?? new Date()).toISOString();
    writeJsonAtomic(usageLedgerFile(), ledger, { pretty: false });
    return { changed, pendingFiles };
  } finally {
    release();
  }
}

// Daemon job: one bounded slice shortly after start, then every few minutes;
// back-to-back short gaps while history is still being backfilled.
export function startUsageLedgerJob(opts: {
  log: (message: string) => void;
  firstDelayMs?: number;
  intervalMs?: number;
  backfillDelayMs?: number;
  budgetMs?: number;
  refresh?: (opts: { budgetMs: number }) => RefreshResult;
}): { stop(): void } {
  const firstDelayMs = opts.firstDelayMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const backfillDelayMs = opts.backfillDelayMs ?? 2_000;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const refresh = opts.refresh ?? refreshUsageLedger;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      if (stopped) return;
      let next = intervalMs;
      try {
        if (refresh({ budgetMs }).pendingFiles > 0) next = backfillDelayMs;
      } catch (error) {
        opts.log(`usage ledger refresh failed: ${error}`);
      }
      if (!stopped) schedule(next);
    }, delay);
  };
  schedule(firstDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// --- summary -----------------------------------------------------------------

export interface UsageAmount {
  costUSD: number;
  activeTokens: number;
  cacheReadTokens: number;
  unpricedActiveTokens: number;
  calls: number;
}

type CostClass = "cacheRead" | "cacheWrite1h" | "cacheWrite5m" | "output" | "input";

export interface UsageSummaryAgent {
  name: string;
  provider: Provider;
  repo?: string;
  role?: string;
  model?: string;
  status: string;
  live: boolean;
  range: UsageAmount;
  today: UsageAmount;
  mainCostUSD: number;
  subagentCostUSD: number;
  subagents: number;
  cacheWriteShare: number | null;
  cacheHitRate: number | null;
  context: { tokens: number; window: number | null; pct: number | null; peak: number; compactions: number } | null;
  dailyCostUSD: number[];
  dailyActiveTokens: number[];
}

export interface UsageSummary {
  generatedAt: string;
  host: string;
  indexing: { pendingFiles: number };
  days: string[];
  totals: { today: UsageAmount; last7: UsageAmount; last30: UsageAmount };
  classes: Record<CostClass, { costUSD: number; tokens: number }>;
  byModel: Array<{ model: string; priced: boolean; costUSD: number; activeTokens: number }>;
  byRepo: Array<{ repo: string; costUSD: number; activeTokens: number; agents: number }>;
  agents: UsageSummaryAgent[];
  unattributed: { dailyCostUSD: number[]; dailyActiveTokens: number[]; range: UsageAmount };
  filters: { repos: string[]; providers: Provider[] };
}

export type SummaryRange = 1 | 7 | 30;
export const SUMMARY_RANGES: readonly SummaryRange[] = [1, 7, 30];
const SUMMARY_DAYS = 30;

function emptyAmount(): UsageAmount {
  return { costUSD: 0, activeTokens: 0, cacheReadTokens: 0, unpricedActiveTokens: 0, calls: 0 };
}

function activeOf(counts: UsageCounts): number {
  return (counts[COUNT_INPUT] ?? 0) + (counts[COUNT_WRITE_5M] ?? 0) + (counts[COUNT_WRITE_1H] ?? 0) + (counts[COUNT_OUTPUT] ?? 0);
}

function addAmount(target: UsageAmount, counts: UsageCounts, cost: number | undefined): void {
  const active = activeOf(counts);
  target.calls += counts[COUNT_CALLS] ?? 0;
  target.activeTokens += active;
  target.cacheReadTokens += counts[COUNT_READ] ?? 0;
  if (cost === undefined) target.unpricedActiveTokens += active;
  else target.costUSD += cost;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function roundAmount(a: UsageAmount): UsageAmount {
  return { ...a, costUSD: round4(a.costUSD) };
}

export function summaryDays(now: Date, count = SUMMARY_DAYS): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    days.push(localDay(d));
  }
  return days;
}

interface AgentAccumulator {
  name: string;
  createdAt?: string;
  provider: Provider;
  repo?: string;
  role?: string;
  range: UsageAmount;
  today: UsageAmount;
  last30Calls: number;
  mainCost: number;
  subCost: number;
  writeCost: number;
  priced: boolean;
  inputTokens: number;
  writeTokens: number;
  readTokens: number;
  subagentPaths: Set<string>;
  daily: number[];
  dailyTokens: number[];
  mainEntry?: LedgerFileEntry;
}

export function usageSummary(opts: {
  range: SummaryRange;
  repo?: string;
  provider?: Provider;
  now?: Date;
  ledger?: UsageLedger;
}): UsageSummary {
  const now = opts.now ?? new Date();
  const ledger = opts.ledger ?? readUsageLedger();
  const days = summaryDays(now);
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const todayIndex = days.length - 1;
  const rangeStart = days.length - opts.range;
  const last7Start = days.length - 7;

  const totals = { today: emptyAmount(), last7: emptyAmount(), last30: emptyAmount() };
  const classes: UsageSummary["classes"] = {
    cacheRead: { costUSD: 0, tokens: 0 },
    cacheWrite1h: { costUSD: 0, tokens: 0 },
    cacheWrite5m: { costUSD: 0, tokens: 0 },
    output: { costUSD: 0, tokens: 0 },
    input: { costUSD: 0, tokens: 0 },
  };
  const byModel = new Map<string, { model: string; priced: boolean; costUSD: number; activeTokens: number }>();
  const byRepo = new Map<string, { repo: string; costUSD: number; activeTokens: number; agents: Set<string> }>();
  const agents = new Map<string, AgentAccumulator>();
  const unattributed = {
    daily: new Array<number>(days.length).fill(0),
    dailyTokens: new Array<number>(days.length).fill(0),
    range: emptyAmount(),
  };
  const repoFilters = new Set<string>();
  const providerFilters = new Set<Provider>();

  for (const [path, entry] of Object.entries(ledger.files)) {
    const owner = entry.owner;
    const inWindow = Object.keys(entry.days).some((d) => dayIndex.has(d));
    if (!inWindow) continue;
    providerFilters.add(entry.provider);
    if (owner?.repo) repoFilters.add(owner.repo);
    if (opts.provider && entry.provider !== opts.provider) continue;
    if (opts.repo && owner?.repo !== opts.repo) continue;

    let acc: AgentAccumulator | undefined;
    if (owner) {
      const agentKey = `${owner.agent}\u0000${owner.agentCreatedAt ?? ""}`;
      acc = agents.get(agentKey);
      if (!acc) {
        acc = {
          name: owner.agent,
          createdAt: owner.agentCreatedAt,
          provider: entry.provider,
          repo: owner.repo,
          role: owner.role,
          range: emptyAmount(),
          today: emptyAmount(),
          last30Calls: 0,
          mainCost: 0,
          subCost: 0,
          writeCost: 0,
          priced: false,
          inputTokens: 0,
          writeTokens: 0,
          readTokens: 0,
          subagentPaths: new Set(),
          daily: new Array<number>(days.length).fill(0),
          dailyTokens: new Array<number>(days.length).fill(0),
        };
        agents.set(agentKey, acc);
      }
      if (owner.kind === "main" && entry.context) {
        const current = acc.mainEntry;
        if (!current || Date.parse(entry.lastAt ?? "") >= Date.parse(current.lastAt ?? "")) acc.mainEntry = entry;
      }
    }

    for (const [day, buckets] of Object.entries(entry.days)) {
      const index = dayIndex.get(day);
      if (index === undefined) continue;
      for (const [key, counts] of Object.entries(buckets)) {
        const breakdown = costBreakdown(counts, key);
        const cost = breakdown?.total;
        const active = activeOf(counts);
        addAmount(totals.last30, counts, cost);
        if (index >= last7Start) addAmount(totals.last7, counts, cost);
        if (index === todayIndex) addAmount(totals.today, counts, cost);

        if (acc) {
          acc.last30Calls += counts[COUNT_CALLS] ?? 0;
          acc.daily[index]! += cost ?? 0;
          acc.dailyTokens[index]! += active;
          if (index === todayIndex) addAmount(acc.today, counts, cost);
        } else {
          unattributed.daily[index]! += cost ?? 0;
          unattributed.dailyTokens[index]! += active;
        }

        if (index < rangeStart) continue;
        classes.input.tokens += counts[COUNT_INPUT] ?? 0;
        classes.cacheWrite5m.tokens += counts[COUNT_WRITE_5M] ?? 0;
        classes.cacheWrite1h.tokens += counts[COUNT_WRITE_1H] ?? 0;
        classes.cacheRead.tokens += counts[COUNT_READ] ?? 0;
        classes.output.tokens += counts[COUNT_OUTPUT] ?? 0;
        if (breakdown) {
          classes.input.costUSD += breakdown.input;
          classes.cacheWrite5m.costUSD += breakdown.cacheWrite5m;
          classes.cacheWrite1h.costUSD += breakdown.cacheWrite1h;
          classes.cacheRead.costUSD += breakdown.cacheRead;
          classes.output.costUSD += breakdown.output;
        }

        const model = parseBucketKey(key).model;
        const modelRow = byModel.get(model) ?? { model, priced: priceFor(model) !== undefined, costUSD: 0, activeTokens: 0 };
        modelRow.costUSD += cost ?? 0;
        modelRow.activeTokens += active;
        byModel.set(model, modelRow);

        if (acc) {
          addAmount(acc.range, counts, cost);
          if (owner!.kind === "subagent") {
            acc.subCost += cost ?? 0;
            if ((counts[COUNT_CALLS] ?? 0) > 0) acc.subagentPaths.add(path);
          } else {
            acc.mainCost += cost ?? 0;
          }
          acc.inputTokens += counts[COUNT_INPUT] ?? 0;
          acc.writeTokens += (counts[COUNT_WRITE_5M] ?? 0) + (counts[COUNT_WRITE_1H] ?? 0);
          acc.readTokens += counts[COUNT_READ] ?? 0;
          if (breakdown) {
            acc.priced = true;
            acc.writeCost += breakdown.cacheWrite5m + breakdown.cacheWrite1h;
          }
          if (acc.repo) {
            const repoRow = byRepo.get(acc.repo) ?? { repo: acc.repo, costUSD: 0, activeTokens: 0, agents: new Set<string>() };
            repoRow.costUSD += cost ?? 0;
            repoRow.activeTokens += active;
            repoRow.agents.add(`${acc.name}\u0000${acc.createdAt ?? ""}`);
            byRepo.set(acc.repo, repoRow);
          }
        } else {
          addAmount(unattributed.range, counts, cost);
        }
      }
    }
  }

  const current = new Map(listAgents().map((a) => [a.name, a]));
  const agentRows: UsageSummaryAgent[] = [];
  for (const acc of agents.values()) {
    if (acc.last30Calls === 0) continue;
    const agent = current.get(acc.name);
    const same = agent && (!acc.createdAt || agent.createdAt === acc.createdAt);
    let status = "removed";
    if (same) {
      try {
        status = displayStatus(agent);
      } catch {
        status = agent.status;
      }
    }
    const live = status !== "removed" && status !== "dead" && status !== "exited";
    const ctx = acc.mainEntry?.context;
    const model = ctx?.model ?? (same ? agent.model : undefined);
    const window = ctx ? (contextWindowFor(ctx.model) ?? null) : null;
    const promptTokens = acc.inputTokens + acc.writeTokens + acc.readTokens;
    agentRows.push({
      name: acc.name,
      provider: acc.provider,
      ...(acc.repo ? { repo: acc.repo } : {}),
      ...(acc.role ? { role: acc.role } : {}),
      ...(model ? { model } : {}),
      status,
      live,
      range: roundAmount(acc.range),
      today: roundAmount(acc.today),
      mainCostUSD: round4(acc.mainCost),
      subagentCostUSD: round4(acc.subCost),
      subagents: acc.subagentPaths.size,
      cacheWriteShare: acc.priced && acc.range.costUSD > 0 ? round4(acc.writeCost / acc.range.costUSD) : null,
      cacheHitRate: promptTokens > 0 ? round4(acc.readTokens / promptTokens) : null,
      context: ctx
        ? {
            tokens: ctx.tokens,
            window,
            pct: window ? Math.round((ctx.tokens / window) * 1000) / 10 : null,
            peak: ctx.peak,
            compactions: ctx.compactions,
          }
        : null,
      dailyCostUSD: acc.daily.map(round4),
      dailyActiveTokens: acc.dailyTokens,
    });
  }
  agentRows.sort((a, b) => b.range.costUSD - a.range.costUSD || b.range.activeTokens - a.range.activeTokens || a.name.localeCompare(b.name));

  const roundClass = (c: { costUSD: number; tokens: number }) => ({ costUSD: round4(c.costUSD), tokens: c.tokens });
  return {
    generatedAt: now.toISOString(),
    host: localHostIdentity(),
    indexing: { pendingFiles: ledger.pendingFiles },
    days,
    totals: { today: roundAmount(totals.today), last7: roundAmount(totals.last7), last30: roundAmount(totals.last30) },
    classes: {
      cacheRead: roundClass(classes.cacheRead),
      cacheWrite1h: roundClass(classes.cacheWrite1h),
      cacheWrite5m: roundClass(classes.cacheWrite5m),
      output: roundClass(classes.output),
      input: roundClass(classes.input),
    },
    byModel: [...byModel.values()]
      .filter((m) => m.activeTokens > 0 || m.costUSD > 0)
      .map((m) => ({ ...m, costUSD: round4(m.costUSD) }))
      .sort((a, b) => b.costUSD - a.costUSD || b.activeTokens - a.activeTokens),
    byRepo: [...byRepo.values()]
      .map((r) => ({ repo: r.repo, costUSD: round4(r.costUSD), activeTokens: r.activeTokens, agents: r.agents.size }))
      .sort((a, b) => b.costUSD - a.costUSD || b.activeTokens - a.activeTokens),
    agents: agentRows,
    unattributed: {
      dailyCostUSD: unattributed.daily.map(round4),
      dailyActiveTokens: unattributed.dailyTokens,
      range: roundAmount(unattributed.range),
    },
    filters: { repos: [...repoFilters].sort(), providers: [...providerFilters].sort() },
  };
}
