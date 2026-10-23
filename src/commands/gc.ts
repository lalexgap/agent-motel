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
      lines.push(`  ${t.name.padEnd(16)} removed ${t.trashedAt ? relativeTime(t.trashedAt) : "(unknown)"}`);
    }
  }

  if (plan.orphans.length > 0) {
    lines.push("orphaned files — remove:");
    for (const o of plan.orphans) {
      lines.push(`  ${o.kind.padEnd(14)} ${shortenHome(o.path)}`);
    }
  }

  if (plan.worktrees.length > 0) {
    lines.push("unreferenced clean worktrees — remove (their branches stay in the repo):");
    for (const w of plan.worktrees) lines.push(`  ${shortenHome(w.path)}`);
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
  const config = loadConfig();
  const agentDays = opts.agentDays ?? config.gcAgentDays;
  const trashDays = opts.trashDays ?? config.gcTrashDays;
  const plan = planGc({ agentDays, trashDays });

  // Unreferenced worktrees gc refuses to touch (dirty, not a linked worktree)
  // are worth surfacing on every path — they're what gc deliberately keeps.
  const keptLines = plan.keptWorktrees.map((w) => `kept ${shortenHome(w.path)} — ${w.reason}`);

  if (gcIsEmpty(plan)) {
    for (const line of keptLines) console.log(line);
    console.log("nothing to collect");
    return;
  }

  if (opts.apply) {
    for (const line of applyGc(plan)) console.log(line);
  } else {
    console.log("gc plan (dry run — execute with `am gc --apply`):");
    for (const line of renderPlan(plan, agentDays, trashDays)) console.log(line);
  }
  for (const line of keptLines) console.log(line);
}
