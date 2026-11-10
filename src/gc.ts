import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { listAgents, readAgent, type AgentState } from "./state";
import { listTrashed, removeTrashed, type TrashedState } from "./trash";
import { hasSession } from "./tmux";
import { agentsDir, artifactsCacheDir, gcInspectedFile, gcLockFile, gcLogFile, handoffsDir, inboxRootDir, logsDir, queueDir, sharedRootDir, trashDir, worktreesDir } from "./paths";
import { queueEntryOwner } from "./queue";
import { listSnapshots } from "./snapshots";
import { listSubagentLedgers } from "./subagents";
import { readFileTail, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { tryAcquireFileLock } from "./filelock";
import { destroyAgent } from "./commands/rm";
import { inferWorktree, withWorktreeMeta } from "./commands/move";
import { forgetCodexTrust, readCodexTrustLedger } from "./codexDaemon";
import { forgetClaudeTrust, readClaudeTrustLedger } from "./claudeTrust";
import type { Config } from "./config";
import { awaitQuiet, pressureReason, readPressure } from "./pressure";
import {
  KEEP_MARKER, canonicalPath, readOwnerRecords, salvageWorktree, withWorktreeDeletionLock, worktreeCommitSafety, worktreeOwnerReason, worktreeSafety,
  type Owner, type OwnerKind, type OwnerRecord, type SafetyFinding, type Salvage, type StatusPath,
} from "./worktreeOwnership";

// Lifecycle GC: agents, trash, and their on-disk leavings only ever
// accumulate. `am gc` plans (dry-run by default) and applies collection of:
//   • agents whose session is gone and that haven't been touched in
//     gcAgentDays, or gcMergedDays once every pull request they track has
//     merged — reaped via the normal rm path, so they land in trash and stay
//     restorable
//   • trash snapshots older than gcTrashDays
//   • orphaned queue/inbox/snapshot/subagent files whose agent no longer
//     exists, and handoff transcripts and cached artifacts past gcFileDays
//   • worktrees under ~/.agent-manager/worktrees, and the subagent worktrees
//     nested in them, that no registered agent owns and no restorable agent
//     still holds (see `released`) — removed when clean and pushed, or, past
//     gcStaleDays without a change, after their changes are saved to a ref
//   • codex trust entries am wrote to config.toml for dirs that are gone
//   • claude folder trust am wrote to ~/.claude.json for dirs that are gone
// The scheduled sweep (autoGc.ts) applies the same policy, throttled.

const DAY_MS = 86_400_000;
// A just-created stray may belong to an agent mid-registration or mid-move —
// only files old enough that no in-flight operation can own them are garbage.
const ORPHAN_GRACE_MS = DAY_MS;
const LOG_MAX_BYTES = 5_000_000;
// A kept worktree is looked at again this often even when nothing suggests it
// changed: a push, or a file deleted deep in the tree, leaves no cheap trace.
const RECHECK_MS = 7 * DAY_MS;
// Deleting a large checkout from a slow disk takes far longer than inspecting it.
const REMOVE_TIMEOUT_MS = 15 * 60_000;

export interface GcOptions {
  agentDays: number;
  trashDays: number;
  // Days after its last pull request merged that an exited agent is reaped and
  // its worktree released. Unset: merges change nothing.
  mergedDays?: number;
  // Days a removed agent's worktree is held for `am restore`. Unset: as long
  // as its trash snapshot.
  removedDays?: number;
  // Days without activity before an unowned worktree is collected. Unset: 0.
  orphanDays?: number;
  // Days without a change before a dirty or unpushed unowned worktree is
  // salvaged to a ref and removed. Unset or 0: never.
  staleDays?: number;
  // The same, when everything left in it is git-ignored. Unset or 0: staleDays.
  ignoredDays?: number;
  // Days before handoff transcripts and cached artifacts age out. Unset: never.
  fileDays?: number;
  gitTimeoutMs?: number;
  // How long one plan may spend inspecting worktrees; the rest wait for the
  // next run. Unset: no limit.
  budgetMs?: number;
  // Why the host is too busy for the next inspection, or null. The scan waits
  // while it answers, within the budget.
  busy?: () => string | null;
  // The head commit GitHub has for a pull request, or null when unknown.
  prHead?: (url: string) => string | null;
}

// A hand-edited config can hold anything. An age that is not a number must
// never read as "collect now", so it falls back to the cautious default.
function days(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function gcPolicy(config: Config, overrides: { agentDays?: number; trashDays?: number } = {}): GcOptions {
  return {
    agentDays: days(overrides.agentDays ?? config.gcAgentDays, 7),
    trashDays: days(overrides.trashDays ?? config.gcTrashDays, 30),
    mergedDays: days(config.gcMergedDays, 3),
    removedDays: days(config.gcRemovedDays, 7),
    orphanDays: days(config.gcOrphanDays, 3),
    staleDays: days(config.gcStaleDays, 0),
    ignoredDays: days(config.gcIgnoredDays, 0),
    fileDays: days(config.gcFileDays, 30),
    gitTimeoutMs: 20_000,
    budgetMs: 5 * 60_000,
    busy: () => pressureReason(readPressure(), config),
  };
}

export interface OrphanCandidate {
  kind: "queue" | "inbox" | "shared" | "snapshot" | "subagents" | "corrupt-state" | "handoff" | "cache";
  path: string;
  // The agent name this file would belong to — re-checked at apply time so a
  // name that got (re)registered since planning is left alone.
  owner?: string;
}

export interface WorktreeCandidate {
  path: string;
  // Set for a subagent worktree: the managed worktree it is nested in.
  parent?: string;
}

export interface WorktreeRemoval {
  path: string;
  repoRoot: string;
  // Not clean: its changes are saved to a ref before a forced removal.
  salvage?: string;
}

export type KeptKind = "marker" | "lease" | "recent" | "dirty" | "unpushed" | "other";
export interface KeptWorktree {
  path: string;
  reason: string;
  kind: KeptKind;
}

export interface GcPlan {
  agents: AgentState[];
  trash: TrashedState[];
  orphans: OrphanCandidate[];
  worktrees: WorktreeRemoval[];
  // Unowned but deliberately not collected — surfaced so the user knows.
  keptWorktrees: KeptWorktree[];
  // Worktrees an agent still owns: never candidates, only counted.
  ownedWorktrees: number;
  // Candidates the scan did not reach, and why it stopped; the next run
  // starts with them.
  uninspectedWorktrees: number;
  stopped?: string;
  codexTrust: string[];
  claudeTrust: string[];
}

export interface GcLogEntry {
  at: string;
  run?: string;
  source: "manual" | "auto";
  mode: "dry-run" | "apply";
  action: "reap-agent" | "purge-trash" | "remove-file" | "remove-worktree" | "keep-worktree" | "forget-trust" | "restore-worktree";
  path?: string;
  name?: string;
  repoRoot?: string;
  branch?: string;
  head?: string;
  salvageRef?: string;
  bytes?: number;
  reason?: string;
}

export interface GcContext {
  source: "manual" | "auto";
  run?: string;
  // Measure a worktree before removing it, for the freed-space total.
  measure?: boolean;
}

export function logGc(entry: Omit<GcLogEntry, "at">): void {
  try {
    mkdirSync(logsDir(), { recursive: true });
    try {
      if (statSync(gcLogFile()).size > LOG_MAX_BYTES) renameSync(gcLogFile(), `${gcLogFile()}.old`);
    } catch {
      // no log yet
    }
    appendFileSync(gcLogFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // The log is a record, not a gate: gc proceeds without it.
  }
}

export function readGcLog(): GcLogEntry[] {
  const entries: GcLogEntry[] = [];
  for (const file of [`${gcLogFile()}.old`, gcLogFile()]) {
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as GcLogEntry); }
      catch { /* a torn line */ }
    }
  }
  return entries;
}

// Null when another gc — manual or scheduled — is already running.
export function acquireGcLock(): (() => void) | null {
  return tryAcquireFileLock(gcLockFile());
}

// Missing/garbage timestamps read as infinitely old: gc exists to collect
// exactly the records nothing maintains anymore.
function ageDays(iso: string | undefined, now: number): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? (now - ms) / DAY_MS : Infinity;
}

function olderThan(path: string, ms: number, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > ms;
  } catch {
    return false; // vanished — nothing to collect
  }
}

function git(dir: string, args: string[], timeoutMs = 5_000): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { timeout: timeoutMs, killSignal: "SIGKILL" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

// Every pull request the agent tracks has been merged for longer than
// mergedDays: its branch is on the remote's main line and it has nothing left
// to do in the worktree.
function mergedLongAgo(owner: Owner, opts: GcOptions, now: number): boolean {
  if (opts.mergedDays === undefined) return false;
  const prs = owner.prMonitor?.pullRequests ?? [];
  return prs.length > 0 && prs.every((pr) => pr.state === "MERGED" && ageDays(pr.mergedAt, now) > opts.mergedDays!);
}

// Whether a record has stopped protecting its worktree. A registered agent
// never has — `am resume` needs the directory — unless this very run reaps
// it, which leaves a trash snapshot dated now. A trash snapshot holds the
// worktree for removedDays, or not at all once its pull requests merged:
// `am restore` recreates the worktree from its branch either way.
function releasePredicate(opts: GcOptions, now: number, reaping: AgentState[] = []) {
  const removedDays = opts.removedDays ?? opts.trashDays;
  return (owner: Owner, kind: OwnerKind): boolean => {
    if (kind === "agent") {
      if (!reaping.some((a) => a.name === owner.name && a.createdAt === owner.createdAt)) return false;
      return removedDays <= 0 || mergedLongAgo(owner, opts, now);
    }
    return ageDays(owner.trashedAt, now) > removedDays || mergedLongAgo(owner, opts, now);
  };
}

function orphanScan(
  liveNames: Set<string>,
  restorableNames: Set<string>,
  opts: GcOptions,
  now: number,
): OrphanCandidate[] {
  const orphans: OrphanCandidate[] = [];
  const trashDays = opts.trashDays;

  if (existsSync(queueDir())) {
    for (const entry of readdirSync(queueDir(), { withFileTypes: true })) {
      const owner = queueEntryOwner(entry.name, entry.isDirectory());
      // A live agent's queue and (transient) deliver lock are load-bearing —
      // only old files whose owner no longer exists are garbage.
      if (!owner || liveNames.has(owner)) continue;
      const path = join(queueDir(), entry.name);
      if (olderThan(path, ORPHAN_GRACE_MS, now)) orphans.push({ kind: "queue", path, owner });
    }
  }

  for (const s of listSnapshots()) {
    if (!liveNames.has(s.name) && olderThan(s.path, ORPHAN_GRACE_MS, now)) {
      orphans.push({ kind: "snapshot", path: s.path, owner: s.name });
    }
  }

  for (const ledger of listSubagentLedgers()) {
    if (!liveNames.has(ledger.name) && olderThan(ledger.path, ORPHAN_GRACE_MS, now)) {
      orphans.push({ kind: "subagents", path: ledger.path, owner: ledger.name });
    }
  }

  // Inboxes hold files handed to the agent; a restorable (trashed) agent may
  // still come back for them, so only truly ownerless inboxes go.
  if (existsSync(inboxRootDir())) {
    for (const name of readdirSync(inboxRootDir())) {
      if (liveNames.has(name) || restorableNames.has(name)) continue;
      const path = join(inboxRootDir(), name);
      if (olderThan(path, ORPHAN_GRACE_MS, now)) orphans.push({ kind: "inbox", path, owner: name });
    }
  }

  // The operator bucket has no agent state and must never be swept.
  if (existsSync(sharedRootDir())) {
    for (const name of readdirSync(sharedRootDir())) {
      if (name === "operator" || liveNames.has(name) || restorableNames.has(name)) continue;
      const path = join(sharedRootDir(), name);
      if (olderThan(path, ORPHAN_GRACE_MS, now)) orphans.push({ kind: "shared", path, owner: name });
    }
  }

  // Quarantined state files and stray atomic-write tmps, once old enough
  // that nobody is coming to inspect them.
  if (existsSync(agentsDir())) {
    for (const f of readdirSync(agentsDir())) {
      if (!f.endsWith(".corrupt") && !f.endsWith(".tmp")) continue;
      const path = join(agentsDir(), f);
      if (olderThan(path, trashDays * DAY_MS, now)) orphans.push({ kind: "corrupt-state", path });
    }
  }

  // Unparseable trash snapshots are invisible to listTrashed (and so to the
  // normal purge) — collect them here or they live forever.
  if (existsSync(trashDir())) {
    for (const f of readdirSync(trashDir())) {
      if (!f.endsWith(".json")) continue;
      const path = join(trashDir(), f);
      if (readJsonOrNull(path) === null && olderThan(path, trashDays * DAY_MS, now)) {
        orphans.push({ kind: "corrupt-state", path });
      }
    }
  }

  if (opts.fileDays !== undefined) {
    const maxAge = opts.fileDays * DAY_MS;
    // A handoff transcript is read once, by the agent that took the work over;
    // its own conversation then carries everything resume and search need.
    if (existsSync(handoffsDir())) {
      for (const entry of readdirSync(handoffsDir(), { withFileTypes: true })) {
        const path = join(handoffsDir(), entry.name);
        if (entry.isFile() && olderThan(path, maxAge, now)) orphans.push({ kind: "handoff", path });
      }
    }
    // Copies of files shared from other hosts: fetched again on demand.
    for (const path of filesUnder(artifactsCacheDir(), 3)) {
      if (olderThan(path, maxAge, now)) orphans.push({ kind: "cache", path });
    }
  }

  return orphans;
}

function filesUnder(dir: string, depth: number): string[] {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory() && depth > 1) files.push(...filesUnder(path, depth - 1));
  }
  return files;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

// Where provider subagents (Claude's Task tool, Codex) check out their own
// worktrees: inside the agent's worktree.
function nestedWorktrees(path: string): string[] {
  return subdirs(join(path, ".claude", "worktrees"));
}

// Every worktree gc may consider, without touching git: the managed ones and
// the subagent worktrees nested in them. A nested one comes before its parent,
// which cannot be clean while it exists.
export function listWorktreeCandidates(): WorktreeCandidate[] {
  const candidates: WorktreeCandidate[] = [];
  for (const repoDir of subdirs(worktreesDir())) {
    for (const path of subdirs(repoDir)) {
      for (const nested of nestedWorktrees(path)) candidates.push({ path: nested, parent: path });
      candidates.push({ path });
    }
  }
  return candidates;
}

function mtime(path: string): number {
  try { return lstatSync(path).mtimeMs; }
  catch { return 0; }
}

// A linked worktree's .git is a file naming its admin dir in the repository.
function adminDir(path: string): string | null {
  try {
    const match = /^gitdir: (.+)$/m.exec(readFileSync(join(path, ".git"), "utf8"));
    return match ? resolve(path, match[1]!.trim()) : null;
  } catch {
    return null; // a directory (a full clone), or no checkout at all
  }
}

// The time of the newest reflog entry: the last commit, checkout, reset or
// pull. The file's own mtime says nothing — `git gc` rewrites every reflog.
function lastReflogEntry(admin: string): number {
  const tail = readFileTail(join(admin, "logs", "HEAD"), 4096);
  const line = tail?.trimEnd().split("\n").at(-1);
  const match = line ? /> (\d+) [+-]\d{4}(\t|$)/.exec(line) : null;
  return match ? Number(match[1]) * 1000 : 0;
}

// When the checkout last saw a commit, checkout, or top-level file change,
// without running git. The index is left out: a status refreshes it.
function lastActivity(path: string): number {
  const admin = adminDir(path);
  return Math.max(mtime(path), admin ? mtime(join(admin, "HEAD")) : 0, admin ? lastReflogEntry(admin) : 0);
}

const WALK_LIMIT = 2_000;

// When the uncommitted work was last touched: the newest of the changed files
// themselves. Untracked directories are walked (bounded); ignored ones are
// build output and dependencies, so only the entry itself counts.
function lastChange(path: string, finding: SafetyFinding): number {
  let newest = lastActivity(path);
  let budget = WALK_LIMIT;
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const child = join(dir, entry.name);
      newest = Math.max(newest, mtime(child));
      if (entry.isDirectory()) walk(child);
    }
  };
  for (const file of finding.files ?? []) {
    if (budget-- <= 0) break;
    const target = join(path, file.path);
    newest = Math.max(newest, mtime(target));
    if (file.code !== "!!" && file.path.endsWith("/")) walk(target);
  }
  // An unreadable tree past the budget is treated as changed just now.
  return budget <= 0 ? Infinity : newest;
}

const NESTED_WALK_LIMIT = 200_000;

// Why removing the worktree would destroy another repository, or null. A clone
// or linked worktree can only sit in untracked or ignored paths, which status
// lists; a submodule is a gitlink, and its gitdir lives in the admin dir that
// removal deletes. Unreadable or too large to search: assume one is there.
function nestedRepository(path: string, files: StatusPath[], timeoutMs?: number): string | null {
  const nested = "contains a nested git repository";
  const unknown = "could not check for nested git repositories";
  const admin = adminDir(path);
  if (!admin) return unknown;
  try {
    if (readdirSync(join(admin, "modules")).length > 0) return `${nested} (submodule)`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unknown;
  }
  const stage = git(path, ["ls-files", "--stage", "-z"], timeoutMs);
  if (!stage.ok) return unknown;
  for (const entry of stage.out.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    const gitlink = join(path, entry.slice(entry.indexOf("\t") + 1));
    try { if (readdirSync(gitlink).length > 0) return `${nested} (submodule)`; }
    catch { /* an uninitialized submodule is an empty or missing dir */ }
  }
  let budget = NESTED_WALK_LIMIT;
  let found = false;
  const walk = (dir: string): boolean => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    for (const entry of entries) {
      if (budget-- <= 0) return false;
      if (entry.name === ".git") { found = true; return true; }
      // Package managers never leave a repository in their install trees,
      // and walking them would cost more than the rest of the checkout.
      if (entry.isDirectory() && entry.name !== "node_modules" && !walk(join(dir, entry.name))) return false;
      if (found) return true;
    }
    return true;
  };
  for (const file of files) {
    if (file.code !== "??" && file.code !== "!!") continue;
    const target = join(path, file.path);
    if (basename(target) === ".git") return nested;
    if (!file.path.endsWith("/") || basename(target) === "node_modules") continue;
    if (!walk(target)) return unknown;
    if (found) return nested;
  }
  return null;
}

const prHeads = new Map<string, string | null>();

function githubPrHead(url: string): string | null {
  if (prHeads.has(url)) return prHeads.get(url)!;
  let head: string | null = null;
  try {
    const r = Bun.spawnSync(["gh", "pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"], {
      timeout: 15_000, killSignal: "SIGKILL", env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(out)) head = out;
  } catch {
    // gh missing: no evidence
  }
  prHeads.set(url, head);
  return head;
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

// Decides, for one worktree at a time, whether it can go. `cheap` reads only
// am's own records and a few mtimes; `inspect` runs git and is the expensive
// part the scheduled sweep rations.
// One kept worktree's last inspection. It stands while the checkout shows no
// new activity and `until` has not passed.
interface Inspection { at: number; activity: number; kind: KeptKind; reason: string; until: number; ages: string }

export class WorktreeJudge {
  private records: OwnerRecord[] | undefined;
  private readonly released: (owner: Owner, kind: OwnerKind) => boolean;
  private readonly inspections: Record<string, Inspection>;

  constructor(private readonly opts: GcOptions, private readonly now: number = Date.now(), reaping: AgentState[] = []) {
    this.released = releasePredicate(opts, now, reaping);
    // Unreadable records: leave the index unset so every check reads again and
    // reports why ownership is unknown.
    try { this.records = readOwnerRecords(); }
    catch { this.records = undefined; }
    const saved = readJsonOrNull<Record<string, Inspection>>(gcInspectedFile());
    this.inspections = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }

  // Least recently inspected first, so a run cut short by its budget is
  // continued by the next one; otherwise the scan's order (nested before parent).
  inspectionOrder(pending: WorktreeCandidate[]): WorktreeCandidate[] {
    const position = new Map(pending.map((candidate, index) => [candidate.path, index]));
    const at = (candidate: WorktreeCandidate) => this.inspections[candidate.path]?.at ?? 0;
    return [...pending].sort((a, b) => at(a) - at(b) || position.get(a.path)! - position.get(b.path)!);
  }

  // Callers hold the gc lock, so there is one writer.
  saveInspections(candidates: WorktreeCandidate[]): void {
    const known = new Set(candidates.map((candidate) => candidate.path));
    for (const path of Object.keys(this.inspections)) if (!known.has(path)) delete this.inspections[path];
    try {
      mkdirSync(dirname(gcInspectedFile()), { recursive: true });
      writeJsonAtomic(gcInspectedFile(), this.inspections);
    } catch {
      // Only costs the next run a repeat inspection.
    }
  }

  // The ages a remembered verdict was reached under; it lapses when they change.
  private ages(): string {
    return `${this.opts.staleDays ?? 0}/${this.opts.ignoredDays ?? 0}`;
  }

  private remembered(path: string): KeptWorktree | null {
    const seen = this.inspections[path];
    if (!seen || this.now >= seen.until || seen.activity !== lastActivity(path) || seen.ages !== this.ages()) return null;
    // A push or a merged pull request changes this verdict without touching
    // the checkout, and asking git about commits alone reads no working tree.
    if (seen.kind === "unpushed" && !worktreeCommitSafety(path, this.safetyOptions(path))) return null;
    const days = Math.floor((this.now - seen.at) / DAY_MS);
    return { path, kind: seen.kind, reason: `${seen.reason} (checked ${days === 0 ? "today" : `${days}d ago`})` };
  }

  // "owned": an agent holds it. A KeptWorktree: unowned but not collectable,
  // decided without git. Null: worth inspecting.
  // `fresh` ignores remembered inspections: a removal always looks again.
  cheap(candidate: WorktreeCandidate, fresh = false): KeptWorktree | "owned" | null {
    const { path } = candidate;
    for (const dir of [path, candidate.parent]) {
      if (dir && existsSync(join(dir, KEEP_MARKER))) return { path, kind: "marker", reason: `keep marker (${KEEP_MARKER})` };
    }
    const owner = worktreeOwnerReason(path, undefined, { records: this.records, released: this.released });
    if (owner?.startsWith("owned by dev-pool")) return { path, kind: "lease", reason: owner };
    if (owner?.startsWith("owned by")) return "owned";
    if (owner) return { path, kind: "other", reason: owner };
    const idleDays = (this.now - lastActivity(path)) / DAY_MS;
    if (idleDays < (this.opts.orphanDays ?? 0)) return { path, kind: "recent", reason: `active within ${this.opts.orphanDays}d` };
    return fresh ? null : this.remembered(path);
  }

  inspect(candidate: WorktreeCandidate): { remove: WorktreeRemoval } | { kept: KeptWorktree } {
    const { path } = candidate;
    // inferWorktree also guards against a full clone parked here: it
    // returns null for a main checkout, which must never be swept.
    const info = inferWorktree(path);
    const verdict = info
      ? this.verdict(path, info.repoRoot)
      : { kept: { path, kind: "other" as const, reason: "not a linked git worktree — inspect manually" } };
    if ("kept" in verdict) {
      // A failed or timed-out git says nothing about the worktree: look again next run.
      if (!/failed|could not/.test(verdict.kept.reason)) {
        this.inspections[path] = {
          at: this.now, activity: lastActivity(path), kind: verdict.kept.kind, reason: verdict.kept.reason,
          until: Math.min(this.now + RECHECK_MS, verdict.staleAt ?? Infinity), ages: this.ages(),
        };
      }
      return { kept: verdict.kept };
    }
    delete this.inspections[path];
    return { remove: { path, repoRoot: info!.repoRoot, ...(verdict.salvage ? { salvage: verdict.salvage } : {}) } };
  }

  // The git half, shared by planning and the recheck at removal time.
  // staleAt: when a kept worktree's changes will have sat untouched for staleDays.
  verdict(path: string, repoRoot: string): { kept: KeptWorktree; staleAt?: number } | { salvage?: string } {
    const finding = worktreeSafety(path, repoRoot, this.safetyOptions(path));
    if (!finding) {
      const nested = nestedRepository(path, [], this.opts.gitTimeoutMs);
      return nested ? { kept: { path, kind: "other", reason: nested } } : {};
    }
    let kind: KeptKind = finding.kind === "dirty" ? "dirty" : finding.kind === "other" ? "other" : "unpushed";
    let reason = finding.reason;
    let limit = this.opts.staleDays ?? 0;
    // Nothing but git-ignored leftovers (env files, keys, dependencies) is not
    // work in progress — provided the commits under it are safe, which a dirty
    // status alone does not say.
    if (finding.kind === "dirty" && finding.files!.every((file) => file.code === "!!")) {
      const commits = worktreeCommitSafety(path, this.safetyOptions(path));
      if (commits?.kind === "other") return { kept: { path, kind: "other", reason: commits.reason } };
      if (commits) {
        kind = "unpushed";
        reason = commits.reason;
      } else {
        reason = "only git-ignored files";
        if ((this.opts.ignoredDays ?? 0) > 0) limit = this.opts.ignoredDays!;
      }
    }
    if (!(limit > 0) || finding.kind === "other") return { kept: { path, kind, reason } };
    // Removing the directory would take the nested checkouts' files with it.
    if (nestedWorktrees(path).length > 0) return { kept: { path, kind, reason: `${reason}; contains subagent worktrees` } };
    const nested = nestedRepository(path, finding.files ?? [], this.opts.gitTimeoutMs);
    if (nested) return { kept: { path, kind: "other", reason: `${reason}; ${nested}` } };
    const changed = lastChange(path, finding);
    const idleDays = (this.now - changed) / DAY_MS;
    if (idleDays <= limit) {
      return { kept: { path, kind, reason }, ...(Number.isFinite(changed) ? { staleAt: changed + limit * DAY_MS } : {}) };
    }
    return { salvage: `${reason}, untouched for ${Math.floor(idleDays)}d` };
  }

  private safetyOptions(path: string) {
    return { timeoutMs: this.opts.gitTimeoutMs, requirePushed: true, pushed: (head: string) => this.pushedByPullRequest(path, head) };
  }

  // A squash-merged branch deleted on the remote leaves no remote ref holding
  // HEAD. The pull request an owner tracked still proves it was pushed, when
  // HEAD is the pull request's head or behind it.
  private pushedByPullRequest(path: string, head: string): boolean {
    let records: OwnerRecord[];
    try { records = this.records ?? readOwnerRecords(); }
    catch { return false; }
    const root = canonicalPath(path);
    const name = basename(root);
    for (const { owner, paths, workDirs } of records) {
      if (![...paths, ...workDirs].some((p) => contains(root, p)) && owner.name !== name && !owner.aliases?.includes(name)) continue;
      for (const pr of owner.prMonitor?.pullRequests ?? []) {
        if (pr.state !== "MERGED" || !pr.url) continue;
        const prHead = (this.opts.prHead ?? githubPrHead)(pr.url);
        if (!prHead) continue;
        if (prHead === head || git(path, ["merge-base", "--is-ancestor", head, prHead]).ok) return true;
      }
    }
    return false;
  }

  ownerReason(path: string): string | null {
    return worktreeOwnerReason(path, undefined, { released: this.released });
  }
}

export function diskBytes(path: string): number | undefined {
  try {
    const r = Bun.spawnSync(["du", "-sk", path], { timeout: 120_000, killSignal: "SIGKILL" });
    const kb = Number(r.stdout.toString().split(/\s/)[0]);
    return r.exitCode === 0 && Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export interface RemovalResult {
  removed: boolean;
  line: string;
  bytes?: number;
  kept?: KeptWorktree;
}

// Remove one planned worktree. Everything is checked again under the deletion
// lock — the keep marker, ownership, the lease, the working tree — because
// the plan may be minutes old. The log entry keeps what `am gc --restore`
// needs to recreate it.
export function removeWorktree(w: WorktreeRemoval, opts: GcOptions, context: GcContext): RemovalResult {
  let result: RemovalResult = { removed: false, line: `kept worktree ${w.path}` };
  const keep = (kind: KeptKind, reason: string) => {
    result = { removed: false, line: `kept worktree ${w.path}: ${reason}`, kept: { path: w.path, kind, reason } };
  };
  const lockReason = withWorktreeDeletionLock(() => {
    const judge = new WorktreeJudge(opts);
    const parent = w.path.includes("/.claude/worktrees/") ? dirname(dirname(dirname(w.path))) : undefined;
    const cheap = judge.cheap({ path: w.path, ...(parent ? { parent } : {}) }, true);
    if (cheap === "owned") return keep("other", judge.ownerReason(w.path) ?? "owned by an agent");
    if (cheap) return keep(cheap.kind, cheap.reason);
    const verdict = judge.verdict(w.path, w.repoRoot);
    if ("kept" in verdict) return keep(verdict.kept.kind, verdict.kept.reason);

    const head = git(w.path, ["rev-parse", "HEAD"]);
    const branch = git(w.path, ["symbolic-ref", "--short", "-q", "HEAD"]);
    let salvage: Salvage | undefined;
    if (verdict.salvage) {
      try { salvage = salvageWorktree(w.path, basename(w.path)); }
      catch (error) { return keep("other", `could not save its changes: ${(error as Error).message}`); }
    }
    const bytes = context.measure ? diskBytes(w.path) : undefined;
    const removal = git(w.repoRoot, ["worktree", "remove", ...(salvage ? ["--force"] : []), w.path], REMOVE_TIMEOUT_MS);
    if (!removal.ok) {
      result = { removed: false, line: `warning: could not remove worktree ${w.path}: ${removal.err}`, kept: { path: w.path, kind: "other", reason: "git worktree remove failed" } };
      return;
    }
    logGc({
      source: context.source, mode: "apply", action: "remove-worktree", path: w.path, repoRoot: w.repoRoot,
      ...(context.run ? { run: context.run } : {}),
      ...(branch.ok && branch.out ? { branch: branch.out } : {}),
      ...(head.ok ? { head: head.out } : {}),
      ...(salvage ? { salvageRef: salvage.ref, reason: verdict.salvage } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    });
    result = {
      removed: true,
      line: salvage
        ? `removed stale worktree ${w.path} (${verdict.salvage}; saved as ${salvage.ref})`
        : `removed worktree ${w.path}`,
      ...(bytes !== undefined ? { bytes } : {}),
    };
  });
  if (lockReason) keep("other", lockReason);
  return result;
}

// What the removal log knows about a worktree gc took: enough to recreate it.
export function findRemovedWorktree(ref: string): GcLogEntry | null {
  const wanted = isAbsolute(ref) ? ref : null;
  const removals = readGcLog().filter((e) => e.action === "remove-worktree" && e.mode === "apply" && e.path && e.repoRoot);
  for (const entry of removals.reverse()) {
    if (wanted ? entry.path === wanted : basename(entry.path!) === ref) return entry;
  }
  return null;
}

// Recreate a worktree gc removed, from its branch (or its commit, detached),
// and put salvaged changes back as uncommitted files.
export function restoreWorktree(ref: string): string[] {
  const entry = findRemovedWorktree(ref);
  if (!entry) throw new Error(`no removed worktree "${ref}" in the gc log — see ${gcLogFile()}`);
  const path = entry.path!;
  const repoRoot = entry.repoRoot!;
  if (existsSync(path)) throw new Error(`${path} already exists`);
  if (!existsSync(repoRoot)) throw new Error(`its repository ${repoRoot} no longer exists`);
  const target = entry.branch ?? entry.head;
  if (!target) throw new Error(`the gc log has no branch or commit for ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  let add = git(repoRoot, ["worktree", "add", path, ...(entry.branch ? [entry.branch] : ["--detach", target])], REMOVE_TIMEOUT_MS);
  // The branch may be gone or checked out elsewhere; the commit still exists.
  if (!add.ok && entry.branch && entry.head) add = git(repoRoot, ["worktree", "add", "--detach", path, entry.head], REMOVE_TIMEOUT_MS);
  if (!add.ok) throw new Error(`could not recreate ${path}: ${add.err}`);
  const lines = [`recreated worktree ${path} from ${entry.branch ?? entry.head}`];
  if (entry.salvageRef) {
    const restored = git(path, ["restore", `--source=${entry.salvageRef}`, "--worktree", "--", "."], REMOVE_TIMEOUT_MS);
    lines.push(restored.ok
      ? `put back its uncommitted changes from ${entry.salvageRef}`
      : `warning: could not put back changes from ${entry.salvageRef}: ${restored.err}`);
  }
  logGc({ source: "manual", mode: "apply", action: "restore-worktree", path, repoRoot, ...(entry.branch ? { branch: entry.branch } : {}) });
  return lines;
}

function worktreeScan(judge: WorktreeJudge, opts: GcOptions): { remove: WorktreeRemoval[]; kept: KeptWorktree[]; owned: number; uninspected: number; stopped?: string } {
  const { budgetMs } = opts;
  const remove: WorktreeRemoval[] = [];
  const kept: KeptWorktree[] = [];
  let owned = 0;
  const candidates = listWorktreeCandidates();
  const pending: WorktreeCandidate[] = [];
  for (const candidate of candidates) {
    const cheap = judge.cheap(candidate);
    if (cheap === "owned") owned++;
    else if (cheap) kept.push(cheap);
    else pending.push(candidate);
  }
  const inspected = judge.inspectionOrder(pending);
  const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
  let uninspected = 0;
  let stopped: string | undefined;
  for (const [index, candidate] of inspected.entries()) {
    const stop = awaitQuiet(deadline, opts.busy ?? (() => null), (ms) => Bun.sleepSync(ms));
    if (stop) {
      stopped = stop;
      uninspected = inspected.length - index;
      break;
    }
    const result = judge.inspect(candidate);
    if ("remove" in result) remove.push(result.remove);
    else kept.push(result.kept);
  }
  judge.saveInspections(candidates);
  return { remove, kept, owned, uninspected, ...(stopped ? { stopped } : {}) };
}

// The agents this run reaps, and so the worktree owners it turns restorable.
export function planReaps(opts: GcOptions, now: number = Date.now()): AgentState[] {
  // Reap = the session is gone (exited, killed, lost to a reboot) AND nothing
  // has touched the agent in a while — sooner when all it was waiting on, its
  // pull requests, has merged. hasSession is the truth; the status field can
  // be stale. withWorktreeMeta backfills worktree metadata from git so the
  // trash snapshot keeps enough to recreate the worktree on restore.
  return listAgents()
    .filter((a) => {
      const idle = ageDays(a.updatedAt, now);
      const due = idle > opts.agentDays || (mergedLongAgo(a, opts, now) && idle > opts.mergedDays!);
      return due && !hasSession(a.tmuxSession);
    })
    .map((a) => withWorktreeMeta(a));
}

export function planGc(opts: GcOptions, scope: { worktrees?: boolean } = {}): GcPlan {
  const now = Date.now();
  const live = listAgents();
  const agents = planReaps(opts, now);
  const reaped = new Set(agents.map((a) => a.name));
  const surviving = live.filter((a) => !reaped.has(a.name));

  const allTrashed = listTrashed();
  const trash = allTrashed.filter((t) => ageDays(t.trashedAt, now) > opts.trashDays);
  const purged = new Set(trash.map((t) => t.name));

  // What trash will hold after apply: current snapshots minus the purge, plus
  // the agents reaped this run.
  const restorable = [...allTrashed.filter((t) => !purged.has(t.name)), ...agents];

  const liveNames = new Set(surviving.map((a) => a.name));
  const restorableNames = new Set(restorable.map((r) => r.name));

  // Ownership comes from the records themselves (see WorktreeJudge): any
  // registered agent, and restorable ones until they release the worktree.
  const scan = scope.worktrees === false
    ? { remove: [], kept: [], owned: 0, uninspected: 0 }
    : worktreeScan(new WorktreeJudge(opts, now, agents), opts);
  const { remove, kept, owned, uninspected } = scan;
  return {
    agents,
    trash,
    orphans: orphanScan(liveNames, restorableNames, opts, now),
    worktrees: remove,
    keptWorktrees: kept,
    ownedWorktrees: owned,
    uninspectedWorktrees: uninspected,
    ...("stopped" in scan && scan.stopped ? { stopped: scan.stopped } : {}),
    codexTrust: Object.keys(readCodexTrustLedger()).filter((dir) => !existsSync(dir)),
    claudeTrust: Object.keys(readClaudeTrustLedger()).filter((dir) => !existsSync(dir)),
  };
}

export function gcIsEmpty(plan: GcPlan): boolean {
  return (
    plan.agents.length === 0 &&
    plan.trash.length === 0 &&
    plan.orphans.length === 0 &&
    plan.worktrees.length === 0 &&
    plan.codexTrust.length === 0 &&
    plan.claudeTrust.length === 0
  );
}

// Execute the plan. Every destructive step revalidates against the world
// having moved since planning. Order matters: the purge must precede the
// reaps — a reaped agent may share a name with an old trash snapshot, and
// its fresh snapshot has to survive.
export function applyGc(plan: GcPlan, opts: GcOptions = { agentDays: Infinity, trashDays: Infinity }, context: GcContext = { source: "manual" }): string[] {
  const lines: string[] = [];
  const record = (entry: Pick<GcLogEntry, "action"> & Partial<GcLogEntry>) =>
    logGc({ source: context.source, mode: "apply", ...(context.run ? { run: context.run } : {}), ...entry });

  for (const t of plan.trash) {
    removeTrashed(t.name);
    record({ action: "purge-trash", name: t.name });
    lines.push(`purged trash snapshot "${t.name}" (removed ${t.trashedAt ?? "unknown"})`);
  }

  for (const planned of plan.agents) {
    // Re-read: skip an agent that came back to life, and destroy from fresh
    // state so the trash snapshot keeps fields written since planning.
    const agent = readAgent(planned.name);
    if (!agent) continue; // already gone
    if (hasSession(agent.tmuxSession)) {
      lines.push(`skipped "${agent.name}" — running again`);
      continue;
    }
    destroyAgent(withWorktreeMeta(agent), { clean: false, auditAction: "gc" });
    record({ action: "reap-agent", name: agent.name, path: agent.dir });
    lines.push(`reaped agent "${agent.name}" (restorable with \`am restore ${agent.name}\`)`);
  }

  for (const o of plan.orphans) {
    if (o.owner && readAgent(o.owner)) continue; // owner (re)appeared since planning
    // One unremovable file must not end the sweep: it is retried next run.
    try { rmSync(o.path, { recursive: true, force: true }); }
    catch (error) {
      lines.push(`warning: could not remove ${o.kind} ${o.path}: ${(error as Error).message}`);
      continue;
    }
    record({ action: "remove-file", path: o.path, reason: o.kind });
    lines.push(`removed ${o.kind === "handoff" || o.kind === "cache" ? "old" : "orphaned"} ${o.kind}: ${o.path}`);
  }

  for (const w of plan.worktrees) lines.push(removeWorktree(w, opts, context).line);

  for (const dir of plan.codexTrust) {
    if (existsSync(dir)) continue;
    if (forgetCodexTrust(dir)) lines.push(`removed codex trust entry for ${dir}`);
    else lines.push(`warning: could not remove codex trust entry for ${dir} (is the codex app-server daemon running?)`);
  }

  for (const dir of plan.claudeTrust) {
    if (existsSync(dir)) continue;
    if (forgetClaudeTrust(dir)) lines.push(`removed claude trust entry for ${dir}`);
    else lines.push(`warning: could not remove claude trust entry for ${dir} (~/.claude.json unreadable or locked)`);
  }

  return lines;
}
