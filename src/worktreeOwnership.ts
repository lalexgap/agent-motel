import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentsDir, baseDir, trashDir, worktreesDir } from "./paths";
import { withFileLock } from "./filelock";

interface Owner { name: string; dir: string; worktreePath?: string; createdAt?: string; tmuxSession?: string }

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

// Order: lifecycle/mailbox -> per-agent state -> ownership. Deletion holds
// only ownership during inspection/git removal; never call state writers here.
export function withWorktreeOwnershipLock<T>(fn: () => T): T {
  return withFileLock(join(baseDir(), "locks", "worktree-ownership.lock"), fn);
}

export function withOwnershipClaim<T>(previous: Owner | null, next: Owner, write: () => T): T {
  if (previous && previous.dir === next.dir && previous.worktreePath === next.worktreePath) return write();
  const paths = [next.dir, next.worktreePath].filter((p): p is string => typeof p === "string" && p.length > 0);
  const existed = paths.map((p) => existsSync(p));
  return withWorktreeOwnershipLock(() => {
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
    const pool = process.env.DEV_POOL_ROOT || join(homedir(), ".dev-pool");
    // A never-installed pool has no owners. Once present, all three slot
    // records must be readable: missing/corrupt data cannot prove vacancy.
    try { statSync(pool); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (let id = 1; id <= 3; id++) {
      const state = JSON.parse(readFileSync(join(pool, "state", `slot-${id}.json`), "utf8"));
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
  const r = Bun.spawnSync(["git", "-C", path, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

export function worktreeSafetyReason(path: string): string | null {
  const top = git(path, "rev-parse", "--show-toplevel");
  if (!top.ok || canonicalPath(top.out) !== canonicalPath(path)) return "not a worktree root";
  const status = git(path, "status", "--porcelain", "--untracked-files=all", "--ignored");
  if (!status.ok) return "git status failed";
  if (status.out) return "uncommitted or ignored files";
  const refs = git(path, "for-each-ref", "--contains=HEAD", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes");
  if (!refs.ok || !refs.out) return "HEAD is not reachable from a durable branch or tag";
  return null;
}
