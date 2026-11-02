import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { planFile, plansDir, trashDir } from "./paths";
import { CARETAKER_ROLE, CONCIERGE_ROLE } from "./roles";

const TASK_MAX_CHARS = 4000;
export const PLAN_HEAD_MAX_LINES = 80;
export const PLAN_HEAD_MAX_BYTES = 6000;
// Only a turn this long is expected to have moved the plan; shorter ones are
// usually conversational replies.
export const PLAN_STALE_MIN_SECONDS = 300;

export function planTemplate(name: string, task: string | undefined, createdAt: string): string {
  let body = (task ?? "").trim() || "(none given)";
  if (body.length > TASK_MAX_CHARS) {
    body = `${body.slice(0, TASK_MAX_CHARS)}\n\n(task truncated at ${TASK_MAX_CHARS} characters)`;
  }
  return [
    `# Plan: ${name}`,
    "",
    `Created ${createdAt}`,
    "",
    "## Task",
    "",
    body,
    "",
    "## Goal",
    "",
    "## Current status",
    "",
    "not started",
    "",
    "## Next steps",
    "",
    "-",
    "",
    "## Decisions",
    "",
    "-",
    "",
    "## Notes",
    "",
  ].join("\n");
}

// Never overwrites: the plan is the agent's own running document.
export function ensurePlan(name: string, task: string | undefined, opts: { from?: string } = {}): string {
  const path = planFile(name);
  if (existsSync(path)) return path;
  mkdirSync(plansDir(), { recursive: true });
  if (opts.from && existsSync(opts.from)) copyFileSync(opts.from, path);
  else writeFileSync(path, planTemplate(name, task, new Date().toISOString()));
  return path;
}

// The fleet's housekeeping agents have no task of their own worth a plan.
export function planWanted(agent: { role?: string; noPlan?: boolean }): boolean {
  if (agent.noPlan) return false;
  if (agent.role === CONCIERGE_ROLE || agent.role === CARETAKER_ROLE) return false;
  return loadConfig().plans !== false;
}

// Older agents (created before plans existed) pick one up on their next launch.
export function ensureAgentPlan(agent: { name: string; task?: string; role?: string; noPlan?: boolean }): void {
  if (!planWanted(agent)) return;
  try {
    ensurePlan(agent.name, agent.task);
  } catch {
    // a missing plan must never block a launch
  }
}

export function planHead(
  text: string,
  opts: { maxLines?: number; maxBytes?: number } = {},
): string {
  const maxLines = opts.maxLines ?? PLAN_HEAD_MAX_LINES;
  const maxBytes = opts.maxBytes ?? PLAN_HEAD_MAX_BYTES;
  let head = text.replace(/\s+$/, "");
  let cut = false;
  const lines = head.split("\n");
  if (lines.length > maxLines) {
    head = lines.slice(0, maxLines).join("\n");
    cut = true;
  }
  if (Buffer.byteLength(head) > maxBytes) {
    // Byte-accurate without splitting a multi-byte character.
    head = Buffer.from(head).subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
    const lastBreak = head.lastIndexOf("\n");
    if (lastBreak > 0) head = head.slice(0, lastBreak);
    cut = true;
  }
  return cut ? `${head}\n… (truncated; read the file for the rest)` : head;
}

export function planContext(name: string, path: string, head: string): string {
  return [
    `[am plan] Your running plan for this task is ${path}. Read it when you need the full picture; keep it current: update Current status, Next steps and Decisions whenever they change and before you go idle or hand off. It is injected once per session, not on every turn.`,
    "",
    head,
  ].join("\n");
}

export function planNudge(path: string): string {
  return `[am plan] ${path} was not updated during your last long turn — bring Current status / Next steps / Decisions up to date if they changed.`;
}

export function planIsStale(
  planMtimeMs: number,
  workingSinceIso: string | undefined,
  workedSeconds: number,
  minSeconds = PLAN_STALE_MIN_SECONDS,
): boolean {
  if (!workingSinceIso || workedSeconds < minSeconds) return false;
  const since = Date.parse(workingSinceIso);
  return Number.isFinite(since) && planMtimeMs < since;
}

export function planMtimeMs(name: string): number | null {
  try {
    return statSync(planFile(name)).mtimeMs;
  } catch {
    return null;
  }
}

export function readPlan(name: string): string | null {
  try {
    return readFileSync(planFile(name), "utf8");
  } catch {
    return null;
  }
}

export function renamePlan(oldName: string, newName: string): void {
  if (existsSync(planFile(oldName))) renameSync(planFile(oldName), planFile(newName));
}

// Trash keeps the plan beside the state snapshot so `am restore` brings both back.
function trashedPlanFile(name: string): string {
  return join(trashDir(), `${name}.plan.md`);
}

export function trashPlan(name: string): void {
  if (!existsSync(planFile(name))) return;
  try {
    mkdirSync(trashDir(), { recursive: true });
    renameSync(planFile(name), trashedPlanFile(name));
  } catch {
    // losing the plan must not leave a half-removed agent
  }
}

export function restorePlan(name: string): void {
  if (!existsSync(trashedPlanFile(name)) || existsSync(planFile(name))) return;
  mkdirSync(plansDir(), { recursive: true });
  renameSync(trashedPlanFile(name), planFile(name));
}

// Moved agents carry their plan in the move payload; an existing local plan wins.
export function importPlan(name: string, content: string | undefined): void {
  if (content === undefined || existsSync(planFile(name))) return;
  mkdirSync(plansDir(), { recursive: true });
  writeFileSync(planFile(name), content);
}

// What the next prompt hook should add to context, given the agent's flags:
// the plan head once after a session start, else at most the one-line nudge.
export function planPromptNotes(agent: { name: string; role?: string; noPlan?: boolean; planPending?: boolean; planNudge?: boolean }): string[] {
  if (!agent.planPending && !agent.planNudge) return [];
  if (!planWanted(agent)) return [];
  const text = readPlan(agent.name);
  if (text === null) return [];
  const path = planFile(agent.name);
  return agent.planPending ? [planContext(agent.name, path, planHead(text))] : [planNudge(path)];
}
