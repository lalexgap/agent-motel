import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentsDir, baseDir, trashDir, worktreesDir } from "./paths";
import { withFileLock } from "./filelock";

interface Owner { name: string; dir: string; worktreePath?: string; createdAt?: string; tmuxSession?: string }
export interface OwnershipSource { kind: "agent" | "trash"; owner: Owner }

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

function ownerPaths(value: unknown): Owner {
  const o = value as Owner | null;
  if (!o || typeof o !== "object" || typeof o.name !== "string" || typeof o.dir !== "string" || !isAbsolute(o.dir) ||
      (o.worktreePath !== undefined && (typeof o.worktreePath !== "string" || !isAbsolute(o.worktreePath)))) {
    throw new Error("invalid agent ownership record");
  }
  return o;
}

export function worktreeOwnerReason(path: string, removing?: Owner): string | null {
  try {
    const root = canonicalPath(path);
    for (const dir of [agentsDir(), trashDir()]) {
      for (const file of entries(dir)) {
        if (file.endsWith(".corrupt")) return "unreadable agent ownership record";
        if (!file.endsWith(".json")) continue;
        const owner = ownerPaths(JSON.parse(readFileSync(join(dir, file), "utf8")));
        // Only the exact live record being removed is exempt. A same-name
        // restorable agent is a separate owner, even when it shares the root.
        if (dir === agentsDir() && removing && owner.name === removing.name && owner.createdAt === removing.createdAt && owner.tmuxSession === removing.tmuxSession) continue;
        if ([owner.dir, owner.worktreePath].some((p) => p && contains(root, canonicalPath(p)))) {
          return `owned by ${dir === trashDir() ? "restorable " : ""}agent "${owner.name}"`;
        }
      }
    }
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
  } catch (error) {
    return `ownership information unavailable: ${(error as Error).message}`;
  }
}

function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", path, ...args], { timeout: 5_000, killSignal: "SIGKILL" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

export function worktreeSafetyReason(path: string, repoRoot?: string): string | null {
  const top = git(path, "rev-parse", "--show-toplevel");
  if (!top.ok || canonicalPath(top.out) !== canonicalPath(path)) return "not a worktree root";
  if (repoRoot) {
    const common = git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const directory = git(path, "rev-parse", "--absolute-git-dir");
    if (!common.ok || !directory.ok || canonicalPath(common.out) === canonicalPath(directory.out) ||
        canonicalPath(dirname(common.out)) !== canonicalPath(repoRoot)) return "worktree registration changed";
  }
  const status = git(path, "status", "--porcelain", "--untracked-files=normal", "--ignored");
  if (!status.ok) return "git status failed";
  if (status.out) return "uncommitted or ignored files";
  const refs = git(path, "for-each-ref", "--contains=HEAD", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes");
  if (!refs.ok || !refs.out) return "HEAD is not reachable from a durable branch or tag";
  return null;
}
