import { loadConfig } from "../config";
import { applyGc, gcIsEmpty, planGc, type GcPlan } from "../gc";
import { relativeTime, shortenHome } from "./ls";

export interface GcCommandOptions {
  apply: boolean;
  agentDays?: number;
  trashDays?: number;
}

function renderPlan(plan: GcPlan, agentDays: number, trashDays: number): string[] {
  const lines: string[] = [];

  if (plan.agents.length > 0) {
    lines.push(`agents dead/exited >${agentDays}d — reap (snapshotted to trash, restorable):`);
    for (const a of plan.agents) {
      lines.push(`  ${a.name.padEnd(16)} ${a.status.padEnd(8)} last touched ${relativeTime(a.updatedAt)}  ${shortenHome(a.dir)}`);
    }
  }

  if (plan.trash.length > 0) {
    lines.push(`trash snapshots >${trashDays}d — purge (no longer restorable):`);
    for (const t of plan.trash) {
      lines.push(`  ${t.name.padEnd(16)} removed ${relativeTime(t.trashedAt)}`);
    }
  }

  if (plan.orphans.length > 0) {
    lines.push("orphaned files — remove:");
    for (const o of plan.orphans) {
      lines.push(`  ${o.kind.padEnd(14)} ${shortenHome(o.path)}`);
    }
  }

  const removable = plan.worktrees.filter((w) => w.action === "remove");
  const kept = plan.worktrees.filter((w) => w.action === "keep");
  if (removable.length > 0) {
    lines.push("unreferenced worktrees — remove:");
    for (const w of removable) lines.push(`  ${shortenHome(w.path)} (${w.reason})`);
  }
  if (kept.length > 0) {
    lines.push("unreferenced worktrees — kept:");
    for (const w of kept) lines.push(`  ${shortenHome(w.path)} — ${w.reason}`);
  }

  return lines;
}

export function gcCommand(opts: GcCommandOptions): void {
  const config = loadConfig();
  const agentDays = opts.agentDays ?? config.gcAgentDays;
  const trashDays = opts.trashDays ?? config.gcTrashDays;
  const plan = planGc({ agentDays, trashDays });

  if (gcIsEmpty(plan)) {
    // Dirty/broken worktrees are worth a mention even when nothing is
    // collectable — they are the things gc deliberately won't touch.
    const kept = plan.worktrees.filter((w) => w.action === "keep");
    for (const w of kept) console.log(`kept ${shortenHome(w.path)} — ${w.reason}`);
    console.log("nothing to collect");
    return;
  }

  if (!opts.apply) {
    console.log("gc plan (dry run — execute with `am gc --apply`):");
    for (const line of renderPlan(plan, agentDays, trashDays)) console.log(line);
    return;
  }

  for (const line of applyGc(plan)) console.log(line);
  const kept = plan.worktrees.filter((w) => w.action === "keep");
  for (const w of kept) console.log(`kept ${shortenHome(w.path)} — ${w.reason}`);
}
