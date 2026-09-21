import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listAgents, readAgent, type AgentState } from "./state";
import { listTrashed, removeTrashed, type TrashedState } from "./trash";
import { hasSession } from "./tmux";
import { agentsDir, inboxRootDir, queueDir, sharedRootDir, trashDir, worktreesDir } from "./paths";
import { queueEntryOwner } from "./queue";
import { listSnapshots } from "./snapshots";
import { listSubagentLedgers } from "./subagents";
import { readJsonOrNull } from "./fsutil";
import { destroyAgent } from "./commands/rm";
import { inferWorktree, withWorktreeMeta } from "./commands/move";

// Lifecycle GC: agents, trash, and their on-disk leavings only ever
// accumulate. `am gc` plans (dry-run by default) and applies collection of:
//   • agents whose session is gone and that haven't been touched in
//     gcAgentDays — reaped via the normal rm path, so they land in trash and
//     stay restorable
//   • trash snapshots older than gcTrashDays
//   • orphaned queue/inbox/snapshot/subagent files whose agent no longer exists
//   • unreferenced worktrees under ~/.agent-manager/worktrees — removed only
//     when clean AND unclaimed by any live or restorable (trashed) agent; the
//     branch itself survives in the repo, so committed work is never lost

const DAY_MS = 86_400_000;
// A just-created stray may belong to an agent mid-registration or mid-move —
// only files old enough that no in-flight operation can own them are garbage.
const ORPHAN_GRACE_MS = DAY_MS;

export interface GcOptions {
  agentDays: number;
  trashDays: number;
}

export interface OrphanCandidate {
  kind: "queue" | "inbox" | "shared" | "snapshot" | "subagents" | "corrupt-state";
  path: string;
  // The agent name this file would belong to — re-checked at apply time so a
  // name that got (re)registered since planning is left alone.
  owner?: string;
}

export interface WorktreeRemoval {
  path: string;
  repoRoot: string;
}

export interface KeptWorktree {
  path: string;
  reason: string;
}

export interface GcPlan {
  agents: AgentState[];
  trash: TrashedState[];
  orphans: OrphanCandidate[];
  worktrees: WorktreeRemoval[];
  // Unreferenced but deliberately not collected — surfaced so the user knows.
  keptWorktrees: KeptWorktree[];
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

function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function git(dir: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

function orphanScan(
  liveNames: Set<string>,
  restorableNames: Set<string>,
  trashDays: number,
  now: number,
): OrphanCandidate[] {
  const orphans: OrphanCandidate[] = [];

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

  return orphans;
}

function worktreeScan(referenced: Set<string>): { remove: WorktreeRemoval[]; kept: KeptWorktree[] } {
  const remove: WorktreeRemoval[] = [];
  const kept: KeptWorktree[] = [];
  if (!existsSync(worktreesDir())) return { remove, kept };
  for (const repo of readdirSync(worktreesDir(), { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    const repoDir = join(worktreesDir(), repo.name);
    for (const wt of readdirSync(repoDir, { withFileTypes: true })) {
      if (!wt.isDirectory()) continue;
      const path = join(repoDir, wt.name);
      if (referenced.has(canon(path))) continue;

      // inferWorktree also guards against a full clone parked here: it
      // returns null for a main checkout, which must never be swept.
      const info = inferWorktree(path);
      if (!info) {
        kept.push({ path, reason: "not a linked git worktree — inspect manually" });
        continue;
      }
      const status = git(path, "status", "--porcelain");
      if (!status.ok) {
        kept.push({ path, reason: "git status failed — inspect manually" });
        continue;
      }
      if (status.out !== "") {
        kept.push({ path, reason: "uncommitted changes" });
        continue;
      }
      remove.push({ path, repoRoot: info.repoRoot });
    }
  }
  return { remove, kept };
}

export function planGc(opts: GcOptions): GcPlan {
  const now = Date.now();
  const live = listAgents();

  // Reap = the session is gone (exited, killed, lost to a reboot) AND nothing
  // has touched the agent in a while. hasSession is the truth; the status
  // field can be stale. withWorktreeMeta backfills worktree metadata from git
  // so the trash snapshot keeps enough to recreate the worktree on restore.
  const agents = live
    .filter((a) => ageDays(a.updatedAt, now) > opts.agentDays && !hasSession(a.tmuxSession))
    .map((a) => withWorktreeMeta(a));
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

  // Worktrees referenced by a live agent are load-bearing; ones referenced by
  // a restorable agent are kept too — `am rm` without --clean promises the
  // worktree survives for restore, and gc honors that for the whole trash
  // retention window.
  const referenced = new Set<string>();
  const addRef = (p?: string) => {
    if (p) referenced.add(canon(p));
  };
  for (const a of [...surviving, ...restorable]) {
    addRef(a.worktreePath);
    addRef(a.dir);
  }

  const { remove, kept } = worktreeScan(referenced);
  return {
    agents,
    trash,
    orphans: orphanScan(liveNames, restorableNames, opts.trashDays, now),
    worktrees: remove,
    keptWorktrees: kept,
  };
}

export function gcIsEmpty(plan: GcPlan): boolean {
  return (
    plan.agents.length === 0 &&
    plan.trash.length === 0 &&
    plan.orphans.length === 0 &&
    plan.worktrees.length === 0
  );
}

// Execute the plan. Every destructive step revalidates against the world
// having moved since planning. Order matters: the purge must precede the
// reaps — a reaped agent may share a name with an old trash snapshot, and
// its fresh snapshot has to survive.
export function applyGc(plan: GcPlan): string[] {
  const lines: string[] = [];

  for (const t of plan.trash) {
    removeTrashed(t.name);
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
    destroyAgent(withWorktreeMeta(agent), { clean: false });
    lines.push(`reaped agent "${agent.name}" (restorable with \`am restore ${agent.name}\`)`);
  }

  for (const o of plan.orphans) {
    if (o.owner && readAgent(o.owner)) continue; // owner (re)appeared since planning
    rmSync(o.path, { recursive: true, force: true });
    lines.push(`removed orphaned ${o.kind}: ${o.path}`);
  }

  for (const w of plan.worktrees) {
    const result = git(w.repoRoot, "worktree", "remove", w.path);
    if (result.ok) lines.push(`removed worktree ${w.path}`);
    else lines.push(`warning: could not remove worktree ${w.path}: ${result.err}`);
  }

  return lines;
}
