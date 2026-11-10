import { loadConfig } from "../config";
import { acquireGcLock, applyGc, gcIsEmpty, gcPolicy, planGc, restoreWorktree, type GcOptions, type GcPlan } from "../gc";
import { autoGcStatus, formatGcSummary, runAutoGc, updateAutoGcState } from "../autoGc";
import { relativeTime, shortenHome } from "./ls";

export interface GcCommandOptions {
  apply: boolean;
  agentDays?: number;
  trashDays?: number;
}

function renderPlan(plan: GcPlan, policy: GcOptions): string[] {
  const lines: string[] = [];

  if (plan.agents.length > 0) {
    lines.push(`agents dead/exited >${policy.agentDays}d, or >${policy.mergedDays}d after their pull requests merged — reap (snapshotted to trash, restorable):`);
    for (const a of plan.agents) {
      lines.push(`  ${a.name.padEnd(16)} ${a.status.padEnd(8)} last touched ${relativeTime(a.updatedAt)}  ${shortenHome(a.dir)}`);
    }
  }

  if (plan.trash.length > 0) {
    lines.push(`trash snapshots >${policy.trashDays}d — purge (no longer restorable):`);
    for (const t of plan.trash) {
      lines.push(`  ${t.name.padEnd(16)} removed ${t.trashedAt ? relativeTime(t.trashedAt) : "(unknown)"}`);
    }
  }

  if (plan.orphans.length > 0) {
    lines.push("orphaned and aged-out files — remove:");
    for (const o of plan.orphans) {
      lines.push(`  ${o.kind.padEnd(14)} ${shortenHome(o.path)}`);
    }
  }

  const clean = plan.worktrees.filter((w) => !w.salvage);
  if (clean.length > 0) {
    lines.push("clean, pushed worktrees no agent holds — remove (their branches stay in the repo):");
    for (const w of clean) lines.push(`  ${shortenHome(w.path)}`);
  }

  const stale = plan.worktrees.filter((w) => w.salvage);
  if (stale.length > 0) {
    lines.push(`stale worktrees no agent holds, unchanged >${policy.staleDays}d — save their changes to refs/am-gc/ and remove:`);
    for (const w of stale) lines.push(`  ${shortenHome(w.path)} — ${w.salvage}`);
  }

  if (plan.codexTrust.length > 0) {
    lines.push("codex trust entries am wrote for dirs that no longer exist — remove from ~/.codex/config.toml:");
    for (const dir of plan.codexTrust) lines.push(`  ${shortenHome(dir)}`);
  }

  if (plan.claudeTrust.length > 0) {
    lines.push("claude folder trust am wrote for dirs that no longer exist — remove from ~/.claude.json:");
    for (const dir of plan.claudeTrust) lines.push(`  ${shortenHome(dir)}`);
  }

  return lines;
}

export function gcCommand(opts: GcCommandOptions): void {
  const policy = gcPolicy(loadConfig(), opts);
  // The scan waits out a busy host rather than add to it; say so, once.
  const busy = policy.busy!;
  let told = false;
  policy.busy = () => {
    const reason = busy();
    if (reason && !told) {
      told = true;
      console.error(`gc: pacing worktree inspection while the host is busy (${reason})…`);
    }
    return reason;
  };
  // A second gc would double the disk load and race the first one's removals.
  const release = acquireGcLock();
  if (!release) throw new Error("another gc is running (the scheduled sweep, or another `am gc`) — see `am gc --auto status`");
  try {
    const plan = planGc(policy);

    // Unowned worktrees gc refuses to touch (dirty, not a linked worktree)
    // are worth surfacing on every path — they're what gc deliberately keeps.
    const keptLines = plan.keptWorktrees.map((w) => `kept ${shortenHome(w.path)} — ${w.reason}`);

    if (plan.uninspectedWorktrees > 0) {
      keptLines.push(`${plan.uninspectedWorktrees} worktree(s) not inspected yet (${plan.stopped ?? "time budget"}) — run \`am gc\` again, or leave them to the nightly sweep`);
    }

    if (gcIsEmpty(plan)) {
      for (const line of keptLines) console.log(line);
      console.log("nothing to collect");
      return;
    }

    if (opts.apply) {
      for (const line of applyGc(plan, policy)) console.log(line);
    } else {
      console.log("gc plan (dry run — execute with `am gc --apply`):");
      for (const line of renderPlan(plan, policy)) console.log(line);
    }
    for (const line of keptLines) console.log(line);
  } finally {
    release();
  }
}

// `am gc --auto status|run|pause|resume`: the daemon's scheduled sweep.
export function gcAutoCommand(action: string | undefined, opts: { dryRun?: boolean; force?: boolean } = {}): void {
  switch (action ?? "status") {
    case "status":
      for (const line of autoGcStatus()) console.log(line);
      return;
    case "pause":
      updateAutoGcState((state) => { state.paused ??= { at: new Date().toISOString() }; });
      console.log("auto gc paused — `am gc --auto resume` turns it back on; `am gc` still works by hand");
      return;
    case "resume":
      updateAutoGcState((state) => { delete state.paused; });
      console.log("auto gc resumed");
      return;
    case "run": {
      const result = runAutoGc({ trigger: "manual", dryRun: opts.dryRun, force: opts.force });
      if ("skipped" in result) {
        console.log(`gc sweep skipped: ${result.skipped}${opts.force ? "" : " (--force runs it anyway)"}`);
        return;
      }
      console.log(`gc: ${formatGcSummary(result.summary)}`);
      console.log("details: am gc --auto status");
      return;
    }
    default:
      throw new Error(`unknown \`am gc --auto\` action "${action}" (expected status, run, pause, or resume)`);
  }
}

// `am gc --restore <worktree>`: recreate a worktree gc removed.
export function gcRestoreCommand(ref: string): void {
  for (const line of restoreWorktree(ref)) console.log(line);
}
