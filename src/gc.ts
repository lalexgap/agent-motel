import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { listAgents, type AgentState } from "./state";
import { listTrashed, removeTrashed, type TrashedState } from "./trash";
import { hasSession } from "./tmux";
import { agentsDir, baseDir, queueDir, snapshotsDir, worktreesDir } from "./paths";
import { destroyAgent } from "./commands/rm";

// Lifecycle GC: agents, trash, and their on-disk leavings only ever
// accumulate. `am gc` plans (dry-run by default) and applies collection of:
//   • agents whose session is gone and that haven't been touched in
//     gcAgentDays — reaped via the normal rm path, so they land in trash and
//     stay restorable
//   • trash snapshots older than gcTrashDays
//   • orphaned queue/inbox/snapshot files whose agent no longer exists
//   • unreferenced worktrees under ~/.agent-manager/worktrees — removed only
//     when clean (the branch itself survives in the repo, so committed work
//     is never lost; dirty worktrees are reported and kept)

const DAY_MS = 86_400_000;

export interface GcOptions {
  agentDays: number;
  trashDays: number;
  now?: number;
}

export interface OrphanCandidate {
  kind: "queue" | "inbox" | "snapshot" | "corrupt-state";
  path: string;
}

export interface WorktreeCandidate {
  path: string;
  action: "remove" | "keep";
  reason: string;
  repoRoot?: string;
}

export interface GcPlan {
  agents: AgentState[];
  trash: TrashedState[];
  orphans: OrphanCandidate[];
  worktrees: WorktreeCandidate[];
}

function ageDays(iso: string, now: number): number {
  return (now - Date.parse(iso)) / DAY_MS;
}

function git(dir: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

// The name a stray file in queueDir belongs to: an agent's message dir, its
// legacy jsonl (or a stranded pre-maildir migration claim), or a deliver lock.
export function queueEntryOwner(entry: string, isDir: boolean): string | null {
  if (isDir) return entry;
  const m = /^(.+?)\.(jsonl(\..+)?|deliver\.lock)$/.exec(entry);
  return m ? m[1]! : null;
}

function orphanScan(liveNames: Set<string>, trashNames: Set<string>, trashDays: number, now: number): OrphanCandidate[] {
  const orphans: OrphanCandidate[] = [];

  if (existsSync(queueDir())) {
    for (const entry of readdirSync(queueDir(), { withFileTypes: true })) {
      const owner = queueEntryOwner(entry.name, entry.isDirectory());
      // A live agent's queue and (transient) deliver lock are load-bearing —
      // only files whose owner no longer exists are garbage.
      if (owner && !liveNames.has(owner)) {
        orphans.push({ kind: "queue", path: join(queueDir(), entry.name) });
      }
    }
  }

  if (existsSync(snapshotsDir())) {
    for (const f of readdirSync(snapshotsDir())) {
      const name = f.replace(/\.txt$/, "");
      if (f.endsWith(".txt") && !liveNames.has(name)) {
        orphans.push({ kind: "snapshot", path: join(snapshotsDir(), f) });
      }
    }
  }

  // Inboxes hold files handed to the agent; a restorable (trashed) agent may
  // still come back for them, so only truly ownerless inboxes go.
  const inboxRoot = join(baseDir(), "inbox");
  if (existsSync(inboxRoot)) {
    for (const name of readdirSync(inboxRoot)) {
      if (!liveNames.has(name) && !trashNames.has(name)) {
        orphans.push({ kind: "inbox", path: join(inboxRoot, name) });
      }
    }
  }

  // Quarantined state files and stray atomic-write tmps, once old enough
  // that nobody is coming to inspect them.
  if (existsSync(agentsDir())) {
    for (const f of readdirSync(agentsDir())) {
      if (!f.endsWith(".corrupt") && !f.endsWith(".tmp")) continue;
      const path = join(agentsDir(), f);
      try {
        if (now - statSync(path).mtimeMs > trashDays * DAY_MS) {
          orphans.push({ kind: "corrupt-state", path });
        }
      } catch {
        // vanished — nothing to collect
      }
    }
  }

  return orphans;
}

function worktreeScan(referenced: Set<string>): WorktreeCandidate[] {
  const out: WorktreeCandidate[] = [];
  if (!existsSync(worktreesDir())) return out;
  for (const repo of readdirSync(worktreesDir(), { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    const repoDir = join(worktreesDir(), repo.name);
    for (const wt of readdirSync(repoDir, { withFileTypes: true })) {
      if (!wt.isDirectory()) continue;
      const path = join(repoDir, wt.name);
      if (referenced.has(path)) continue;

      const status = git(path, "status", "--porcelain");
      if (!status.ok) {
        out.push({ path, action: "keep", reason: "not a working git worktree — inspect manually" });
        continue;
      }
      if (status.out !== "") {
        out.push({ path, action: "keep", reason: "uncommitted changes" });
        continue;
      }
      const common = git(path, "rev-parse", "--git-common-dir");
      const repoRoot = common.ok ? dirname(resolve(path, common.out)) : undefined;
      out.push({ path, action: "remove", reason: "clean — its branch stays in the repo", repoRoot });
    }
  }
  return out;
}

export function planGc(opts: GcOptions): GcPlan {
  const now = opts.now ?? Date.now();
  const live = listAgents();

  // Reap = the session is gone (exited, killed, lost to a reboot) AND nothing
  // has touched the agent in a while. hasSession is the truth; the status
  // field can be stale.
  const agents = live.filter(
    (a) => !hasSession(a.tmuxSession) && ageDays(a.updatedAt, now) > opts.agentDays,
  );
  const reaped = new Set(agents.map((a) => a.name));
  const surviving = live.filter((a) => !reaped.has(a.name));

  const allTrashed = listTrashed();
  const trash = allTrashed.filter((t) => t.trashedAt && ageDays(t.trashedAt, now) > opts.trashDays);
  const purged = new Set(trash.map((t) => t.name));

  const liveNames = new Set(surviving.map((a) => a.name));
  // Reaped agents land in trash this run, so their inboxes stay restorable.
  const trashNames = new Set([
    ...allTrashed.filter((t) => !purged.has(t.name)).map((t) => t.name),
    ...reaped,
  ]);

  const referenced = new Set<string>();
  for (const a of surviving) {
    if (a.worktreePath) referenced.add(a.worktreePath);
    referenced.add(a.dir);
  }

  return {
    agents,
    trash,
    orphans: orphanScan(liveNames, trashNames, opts.trashDays, now),
    worktrees: worktreeScan(referenced),
  };
}

export function gcIsEmpty(plan: GcPlan): boolean {
  return (
    plan.agents.length === 0 &&
    plan.trash.length === 0 &&
    plan.orphans.length === 0 &&
    plan.worktrees.every((w) => w.action === "keep")
  );
}

// Execute the plan. Order matters: agents first (their worktrees were already
// treated as unreferenced by the plan), then files, then worktrees.
export function applyGc(plan: GcPlan): string[] {
  const lines: string[] = [];

  for (const agent of plan.agents) {
    destroyAgent(agent, { clean: false });
    lines.push(`reaped agent "${agent.name}" (restorable with \`am restore ${agent.name}\`)`);
  }

  for (const t of plan.trash) {
    removeTrashed(t.name);
    lines.push(`purged trash snapshot "${t.name}" (removed ${t.trashedAt})`);
  }

  for (const o of plan.orphans) {
    rmSync(o.path, { recursive: true, force: true });
    lines.push(`removed orphaned ${o.kind}: ${o.path}`);
  }

  for (const w of plan.worktrees) {
    if (w.action !== "remove") continue;
    const result = w.repoRoot
      ? git(w.repoRoot, "worktree", "remove", w.path)
      : { ok: false, out: "", err: "unknown repo root" };
    if (result.ok) lines.push(`removed worktree ${w.path}`);
    else lines.push(`warning: could not remove worktree ${w.path}: ${result.err}`);
  }

  return lines;
}
