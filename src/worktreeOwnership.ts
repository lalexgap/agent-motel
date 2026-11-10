import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentsDir, baseDir, trashDir, worktreesDir } from "./paths";
import { withFileLock } from "./filelock";

export interface Owner {
  name: string; dir: string; worktreePath?: string; createdAt?: string; tmuxSession?: string;
  aliases?: string[]; workDirs?: string[]; trashedAt?: string;
  prMonitor?: { pullRequests?: { url?: string; state?: string; mergedAt?: string }[] };
}
export type OwnerKind = "agent" | "trash";
export interface OwnershipSource { kind: OwnerKind; owner: Owner }
// One agent or trash record with its claimed paths resolved once, so a scan
// over hundreds of worktrees reads the registry a single time. `paths` are
// where it is registered; `workDirs` are managed worktrees it has worked in.
export interface OwnerRecord { kind: OwnerKind; owner: Owner; paths: string[]; workDirs: string[] }
export interface OwnerCheck {
  // Records read earlier (a scan's index); absent reads the registry now.
  records?: OwnerRecord[];
  // A record this returns true for no longer protects its worktree.
  released?: (owner: Owner, kind: OwnerKind) => boolean;
}
export const KEEP_MARKER = ".am-gc-keep";

export function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) throw error;
    return join(canonicalPath(parent), relative(parent, resolve(path)));
  }
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Order: lifecycle/mailbox -> per-agent state -> ownership. Deletion takes
// pool-allocate before ownership and never calls state writers while locked.
export function withWorktreeOwnershipLock<T>(fn: () => T): T {
  return withFileLock(join(baseDir(), "locks", "worktree-ownership.lock"), fn);
}

function poolRoot(): string {
  return process.env.DEV_POOL_ROOT || join(homedir(), ".dev-pool");
}

export function withWorktreeDeletionLock(fn: () => void): string | null {
  const lock = join(poolRoot(), "locks", "pool-allocate.lock");
  const token = randomUUID();
  let identity: ReturnType<typeof lstatSync>;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    mkdirSync(lock);
    identity = lstatSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token }));
  } catch (error) {
    return `dev-pool allocation lock unavailable: ${(error as Error).message}`;
  }
  try {
    withWorktreeOwnershipLock(fn);
    return null;
  } finally {
    try {
      const current = lstatSync(lock);
      const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      if (current.dev === identity.dev && current.ino === identity.ino && owner.pid === process.pid && owner.token === token) {
        rmSync(lock, { recursive: true });
      }
    } catch { /* A replaced or unreadable lock is not ours to remove. */ }
  }
}

export function withOwnershipClaim<T>(previous: Owner | null, next: Owner, write: () => T, source?: OwnershipSource): T {
  if (previous && previous.dir === next.dir && previous.worktreePath === next.worktreePath) return write();
  const paths = [next.dir, next.worktreePath].filter((p): p is string => typeof p === "string" && p.length > 0);
  const existed = paths.map((p) => existsSync(p));
  return withWorktreeOwnershipLock(() => {
    if (source) {
      const dir = source.kind === "agent" ? agentsDir() : trashDir();
      const saved = ownerPaths(JSON.parse(readFileSync(join(dir, `${source.owner.name}.json`), "utf8")));
      if (saved.name !== source.owner.name || saved.createdAt !== source.owner.createdAt ||
          saved.tmuxSession !== source.owner.tmuxSession || saved.createdAt !== next.createdAt ||
          saved.dir !== next.dir || saved.worktreePath !== next.worktreePath) {
        throw new Error("ownership source changed during identity migration");
      }
      return write();
    }
    for (const [i, path] of paths.entries()) {
      if (!existsSync(path) && (existed[i] || path === next.worktreePath || contains(canonicalPath(worktreesDir()), canonicalPath(path)))) {
        throw new Error(`cannot register ownership of missing worktree directory ${path}`);
      }
    }
    return write();
  });
}

function entries(dir: string): string[] {
  try { return readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function ownerPaths(value: unknown): Owner {
  const o = value as Owner | null;
  if (!o || typeof o !== "object" || typeof o.name !== "string" || typeof o.dir !== "string" || !isAbsolute(o.dir) ||
      (o.worktreePath !== undefined && (typeof o.worktreePath !== "string" || !isAbsolute(o.worktreePath))) ||
      (o.workDirs !== undefined && (!strings(o.workDirs) || !o.workDirs.every((p) => isAbsolute(p)))) ||
      (o.aliases !== undefined && !strings(o.aliases))) {
    throw new Error("invalid agent ownership record");
  }
  return o;
}

// Every registered and restorable agent's claims. Throws on a record that
// cannot be read: unknown ownership must keep a worktree, never free it.
export function readOwnerRecords(): OwnerRecord[] {
  const records: OwnerRecord[] = [];
  for (const [kind, dir] of [["agent", agentsDir()], ["trash", trashDir()]] as const) {
    for (const file of entries(dir)) {
      if (file.endsWith(".corrupt")) throw new Error("unreadable agent ownership record");
      if (!file.endsWith(".json")) continue;
      const owner = ownerPaths(JSON.parse(readFileSync(join(dir, file), "utf8")));
      const paths = [owner.dir, owner.worktreePath]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => canonicalPath(p));
      records.push({ kind, owner, paths, workDirs: (owner.workDirs ?? []).map((p) => canonicalPath(p)) });
    }
  }
  return records;
}

// worktrees/<repo>/<name> is where `am new` puts an agent's worktree. An agent
// registered elsewhere (its home dir) that made such a worktree for itself
// still owns it: the name protects, and is never evidence a worktree is free.
function managedName(root: string): string | null {
  const parts = relative(canonicalPath(worktreesDir()), root).split(sep);
  return parts.length === 2 && parts[0] !== ".." && parts[1] ? parts[1] : null;
}

// The managed worktree (or the subagent worktree nested in one) that `cwd`
// lies in, by path alone: this runs in every hook.
export function managedWorktreeRoot(cwd: string): string | null {
  const bases = [worktreesDir()];
  try { bases.push(realpathSync(worktreesDir())); } catch { /* no worktrees yet */ }
  for (const base of bases) {
    const parts = relative(base, resolve(cwd)).split(sep);
    if (parts.length < 2 || parts[0] === ".." || parts[0] === "" || isAbsolute(parts[0]!)) continue;
    const root = join(base, parts[0]!, parts[1]!);
    return parts[2] === ".claude" && parts[3] === "worktrees" && parts[4] ? join(root, ".claude", "worktrees", parts[4]) : root;
  }
  return null;
}

const MAX_WORK_DIRS = 16;

// Note where a session is working when that is a managed worktree its record
// does not already name. Returns whether the record changed.
export function noteWorkDir(agent: Owner, cwd: string): boolean {
  const root = managedWorktreeRoot(cwd);
  if (!root || agent.workDirs?.at(-1) === root) return false;
  if ([agent.dir, agent.worktreePath].some((p) => p && resolve(p) === root)) return false;
  // Most recent last, so the cap drops the one visited longest ago.
  agent.workDirs = [...(agent.workDirs ?? []).filter((dir) => dir !== root), root].slice(-MAX_WORK_DIRS);
  return true;
}

function poolLeaseReason(root: string): string | null {
  const pool = poolRoot();
  // dev-pool creates slot records lazily; absent records have never held a lease.
  try { statSync(pool); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (let id = 1; id <= 3; id++) {
    const record = join(pool, "state", `slot-${id}.json`);
    let raw: string;
    try { raw = readFileSync(record, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { lstatSync(record); }
      catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw entryError;
      }
      throw error;
    }
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || !Object.hasOwn(state, "lease")) throw new Error("invalid dev-pool slot record");
    if (state.lease === null) continue;
    if (!state.lease || typeof state.lease.worktree !== "string" || !isAbsolute(state.lease.worktree)) throw new Error("invalid dev-pool lease");
    if (contains(root, canonicalPath(state.lease.worktree))) return `owned by dev-pool slot-${id} lease`;
  }
  return null;
}

export function worktreeOwnerReason(path: string, removing?: Owner, check: OwnerCheck = {}): string | null {
  try {
    const root = canonicalPath(path);
    // A subagent worktree belongs with the managed worktree it is nested in.
    const nest = /^(.*)\/\.claude\/worktrees\/[^/]+$/.exec(root)?.[1];
    const homes = [root, ...(nest ? [nest] : [])];
    const registered = ({ owner, paths }: OwnerRecord) => homes.some((home) => {
      const name = managedName(home);
      return paths.some((p) => contains(home, p)) || (name !== null && (owner.name === name || !!owner.aliases?.includes(name)));
    });
    const records = check.records ?? readOwnerRecords();
    // Only the exact live record being removed is exempt. A same-name
    // restorable agent is a separate owner, even when it shares the root.
    const isRemoving = ({ kind, owner }: OwnerRecord) =>
      kind === "agent" && !!removing && owner.name === removing.name && owner.createdAt === removing.createdAt && owner.tmuxSession === removing.tmuxSession;
    // Working in another agent's worktree (a visit, a review) is no claim on it
    // while that agent still holds it; the one being removed still counts.
    const holders = records.filter((r) => registered(r) && (isRemoving(r) || !check.released?.(r.owner, r.kind)));
    const name = managedName(root);
    for (const record of records) {
      const { kind, owner, paths, workDirs } = record;
      if (isRemoving(record) || check.released?.(owner, kind)) continue;
      if (paths.some((p) => contains(root, p)) || (name !== null && (owner.name === name || owner.aliases?.includes(name))) ||
          (workDirs.some((p) => contains(root, p)) && !holders.some((h) => h !== record))) {
        return `owned by ${kind === "trash" ? "restorable " : ""}agent "${owner.name}"`;
      }
    }
    return poolLeaseReason(root);
  } catch (error) {
    const message = (error as Error).message;
    return message === "unreadable agent ownership record" ? message : `ownership information unavailable: ${message}`;
  }
}

const GIT_TIMEOUT_MS = 5_000;

function gitRun(path: string, args: string[], timeoutMs = GIT_TIMEOUT_MS, env?: Record<string, string>) {
  // --no-optional-locks: a status must not rewrite the index of a checkout it only inspects.
  const r = Bun.spawnSync(["git", "--no-optional-locks", "-C", path, ...args], {
    timeout: timeoutMs, killSignal: "SIGKILL", ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

export type SafetyKind = "dirty" | "unpushed" | "unreferenced" | "other";
export interface SafetyFinding {
  kind: SafetyKind;
  reason: string;
  // Changed paths as git reports them (dirty only), relative to the worktree.
  files?: StatusPath[];
}
// code is git's two-letter status: "??" untracked, "!!" ignored, " M" modified…
export interface StatusPath { code: string; path: string }
export interface SafetyOptions {
  timeoutMs?: number;
  // Also keep commits no remote has (repos with a remote only). `pushed` is
  // outside evidence that HEAD was pushed, for a remote branch since deleted.
  requirePushed?: boolean;
  pushed?: (head: string) => boolean;
}

// Why removing this worktree could lose work, or null when it cannot.
export function worktreeSafety(path: string, repoRoot?: string, opts: SafetyOptions = {}): SafetyFinding | null {
  const git = (...args: string[]) => gitRun(path, args, opts.timeoutMs);
  const top = git("rev-parse", "--show-toplevel");
  if (!top.ok || canonicalPath(top.out) !== canonicalPath(path)) return { kind: "other", reason: "not a worktree root" };
  if (repoRoot) {
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
    const directory = git("rev-parse", "--absolute-git-dir");
    if (!common.ok || !directory.ok || canonicalPath(common.out) === canonicalPath(directory.out) ||
        canonicalPath(dirname(common.out)) !== canonicalPath(repoRoot)) return { kind: "other", reason: "worktree registration changed" };
  }
  const status = Bun.spawnSync(["git", "--no-optional-locks", "-C", path, "status", "--porcelain", "-z", "--untracked-files=normal", "--ignored"], {
    timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  if (status.exitCode !== 0) return { kind: "other", reason: "git status failed" };
  const listing = status.stdout.toString();
  const hidden = hiddenChanges(path, opts.timeoutMs ?? GIT_TIMEOUT_MS);
  if (!hidden) return { kind: "other", reason: "could not read skip-worktree files" };
  const files = [...(listing ? statusPaths(listing) : []), ...hidden];
  if (files.length > 0) return { kind: "dirty", reason: "uncommitted or ignored files", files };
  return worktreeCommitSafety(path, opts);
}

// Tracked files status does not look at (skip-worktree, assume-unchanged)
// whose content differs from the index, as status-like "S " entries. A
// sparse checkout's skipped files are absent, not changed. Null: unknown.
function hiddenChanges(path: string, timeoutMs: number): StatusPath[] | null {
  const listing = gitRun(path, ["ls-files", "-v", "-s", "-z"], timeoutMs);
  if (!listing.ok) return null;
  const flagged: { file: string; sha: string }[] = [];
  for (const entry of listing.out.split("\0")) {
    const tag = entry[0];
    if (!tag || (tag !== "S" && !(tag >= "a" && tag <= "z"))) continue;
    const tab = entry.indexOf("\t");
    flagged.push({ file: entry.slice(tab + 1), sha: entry.slice(0, tab).split(" ")[2] ?? "" });
  }
  const changed: StatusPath[] = [];
  const present: { file: string; sha: string }[] = [];
  for (const entry of flagged) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(join(path, entry.file)); }
    catch { continue; }
    if (stat.isFile()) present.push(entry);
    else changed.push({ code: "S ", path: entry.file });
  }
  if (present.length > 0) {
    const hashed = Bun.spawnSync(["git", "--no-optional-locks", "-C", path, "hash-object", "--stdin-paths"], {
      stdin: Buffer.from(present.map((entry) => entry.file).join("\n") + "\n"), timeout: timeoutMs, killSignal: "SIGKILL",
    });
    if (hashed.exitCode !== 0 || present.some((entry) => entry.file.includes("\n"))) return null;
    const shas = hashed.stdout.toString().trim().split("\n");
    present.forEach((entry, i) => { if (shas[i] !== entry.sha) changed.push({ code: "S ", path: entry.file }); });
  }
  return changed;
}

// The half of worktreeSafety that reads commits and refs only, never the
// working tree: whether HEAD would survive, and (requirePushed) is on a remote.
export function worktreeCommitSafety(path: string, opts: SafetyOptions = {}): SafetyFinding | null {
  const git = (...args: string[]) => gitRun(path, args, opts.timeoutMs);
  const refs = git("for-each-ref", "--contains=HEAD", "--count=1", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes");
  if (!refs.ok || !refs.out) return { kind: "unreferenced", reason: "HEAD is not reachable from a durable branch or tag" };
  if (opts.requirePushed) {
    const remotes = git("remote");
    if (!remotes.ok) return { kind: "other", reason: "git remote failed" };
    if (remotes.out) {
      const ahead = git("rev-list", "-n", "1", "HEAD", "--not", "--remotes");
      if (!ahead.ok) return { kind: "other", reason: "could not compare HEAD with the remotes" };
      if (ahead.out) {
        const head = git("rev-parse", "HEAD");
        if (!head.ok || !opts.pushed?.(head.out)) return { kind: "unpushed", reason: "unpushed commits" };
      }
    }
  }
  return null;
}

// `status --porcelain -z`: "XY path\0", with a rename's source as an extra field.
function statusPaths(listing: string): StatusPath[] {
  const fields = listing.split("\0");
  const paths: StatusPath[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    paths.push({ code: field.slice(0, 2), path: field.slice(3) });
    if (field[0] === "R" || field[0] === "C") i++;
  }
  return paths;
}

export function worktreeSafetyReason(path: string, repoRoot?: string, opts: SafetyOptions = {}): string | null {
  return worktreeSafety(path, repoRoot, opts)?.reason ?? null;
}

export interface Salvage {
  ref: string; commit: string; head: string; branch?: string; changes: boolean;
  // Ignored files saved, and the ignored entries left out (a few top-level paths).
  ignored: number; dropped: { count: number; paths: string[] };
}

const IGNORED_FILE_MAX = 1 << 20;
const IGNORED_TOTAL_MAX = 50 << 20;
// An ignored directory with more entries than this is build output or a cache.
const IGNORED_DIR_MAX = 5_000;

// The small ignored files worth keeping (env files, keys, notes, a dev
// database), and what is left out. Symlinks and nested repositories are skipped.
function ignoredFiles(path: string, entries: StatusPath[]): { files: string[]; dropped: string[] } {
  const files: string[] = [];
  const dropped: string[] = [];
  let total = 0;
  const take = (rel: string, size: number): boolean => {
    if (size > IGNORED_FILE_MAX || total + size > IGNORED_TOTAL_MAX) return false;
    total += size;
    files.push(rel);
    return true;
  };
  for (const { code, path: rel } of entries) {
    if (code !== "!!") continue;
    const top = rel.replace(/\/$/, "");
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(join(path, top)); }
    catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (!take(top, stat.size)) dropped.push(top);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const found: { rel: string; size: number }[] = [];
    let count = 0;
    let tooBig = top.split("/").at(-1) === "node_modules";
    const walk = (dir: string): void => {
      let children: import("node:fs").Dirent[];
      try { children = readdirSync(join(path, dir), { withFileTypes: true }); }
      catch { tooBig = true; return; }
      for (const child of children) {
        if (tooBig || ++count > IGNORED_DIR_MAX) { tooBig = true; return; }
        const childRel = `${dir}/${child.name}`;
        if (child.name === ".git" || child.name === "node_modules" || child.isSymbolicLink()) continue;
        if (child.isDirectory()) walk(childRel);
        else if (child.isFile()) {
          try { found.push({ rel: childRel, size: lstatSync(join(path, childRel)).size }); }
          catch { /* vanished */ }
        }
      }
    };
    if (!tooBig) walk(top);
    if (tooBig) {
      dropped.push(`${top}/`);
      continue;
    }
    if (!found.every((file) => take(file.rel, file.size))) dropped.push(`${top}/`);
  }
  return { files, dropped };
}

// Pin everything a forced removal would otherwise drop: the uncommitted and
// untracked files, and small ignored ones, as one commit on top of HEAD under
// refs/am-gc/ in the repository. Throws when it cannot.
export function salvageWorktree(path: string, label: string, timeoutMs = 120_000): Salvage {
  const run = (args: string[], env?: Record<string, string>) => {
    const r = gitRun(path, args, timeoutMs, env);
    if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err || "no output"}`);
    return r.out;
  };
  const head = run(["rev-parse", "HEAD"]);
  const branch = gitRun(path, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs);
  const admin = run(["rev-parse", "--absolute-git-dir"]);
  const index = join(admin, `am-gc-index-${process.pid}`);
  const pathspecs = join(admin, `am-gc-paths-${process.pid}`);
  let commit = head;
  let ignored: { files: string[]; dropped: string[] } = { files: [], dropped: [] };
  try {
    const env = { GIT_INDEX_FILE: index };
    run(["read-tree", "HEAD"], env);
    run(["add", "-A"], env);
    const status = Bun.spawnSync(["git", "--no-optional-locks", "-C", path, "status", "--porcelain", "-z", "--untracked-files=normal", "--ignored"], {
      timeout: timeoutMs, killSignal: "SIGKILL",
    });
    if (status.exitCode !== 0) throw new Error("git status failed");
    ignored = ignoredFiles(path, statusPaths(status.stdout.toString()));
    if (ignored.files.length > 0) {
      writeFileSync(pathspecs, ignored.files.join("\0"));
      run(["add", "-f", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"], { ...env, GIT_LITERAL_PATHSPECS: "1" });
    }
    // An embedded repository (a nested worktree, a clone) would be recorded as
    // a bare pointer and its files lost with the checkout.
    const added = run(["diff-index", "--cached", "--raw", "HEAD"], env);
    if (added.split("\n").some((line) => line.split(" ")[1] === "160000" && line.split(" ")[0] !== ":160000")) {
      throw new Error("contains an embedded git repository");
    }
    const tree = run(["write-tree"], env);
    if (tree !== run(["rev-parse", "HEAD^{tree}"])) {
      const identity = {
        GIT_AUTHOR_NAME: "am gc", GIT_AUTHOR_EMAIL: "am-gc@localhost",
        GIT_COMMITTER_NAME: "am gc", GIT_COMMITTER_EMAIL: "am-gc@localhost",
      };
      commit = run(["commit-tree", tree, "-p", head, "-m", `am gc: uncommitted changes salvaged from ${path}`], identity);
    }
  } finally {
    rmSync(index, { force: true });
    rmSync(pathspecs, { force: true });
  }
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const ref = `refs/am-gc/${label.replaceAll(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]+/, "") || "worktree"}-${stamp}-${randomBytes(3).toString("hex")}`;
  // The all-zero old value: never overwrite a ref that already exists.
  run(["update-ref", ref, commit, "0".repeat(head.length)]);
  return {
    ref, commit, head, ...(branch.ok && branch.out ? { branch: branch.out } : {}), changes: commit !== head,
    ignored: ignored.files.length, dropped: { count: ignored.dropped.length, paths: ignored.dropped.slice(0, 5) },
  };
}
