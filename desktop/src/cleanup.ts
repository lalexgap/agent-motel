import type { CleanupPlan } from "./types";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseCleanupPlan(value: unknown, expectedName: string): CleanupPlan | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as Partial<CleanupPlan>;
  const planName = expectedName.includes(":") ? expectedName.slice(expectedName.indexOf(":") + 1) : expectedName;
  if (plan.name !== planName || typeof plan.createdAt !== "string" || !plan.createdAt || typeof plan.token !== "string" || !/^[a-f0-9]{64}$/.test(plan.token) ||
      !strings(plan.remove) || !strings(plan.keep) || !strings(plan.prs) ||
      !(plan.branch === null || typeof plan.branch === "string") || !Array.isArray(plan.blockers) ||
      !plan.blockers.every((blocker) => blocker && typeof blocker.reason === "string" && typeof blocker.forceable === "boolean")) return null;
  return plan as CleanupPlan;
}

export const cleanupForceable = (plan: CleanupPlan): boolean =>
  plan.blockers.length > 0 && plan.blockers.every((blocker) => blocker.forceable);

export const cleanupBlocked = (plan: CleanupPlan): boolean =>
  plan.blockers.some((blocker) => !blocker.forceable);

export const cleanupCanApply = (plan: CleanupPlan, confirmed: boolean, forceAcknowledged: boolean): boolean =>
  confirmed && !cleanupBlocked(plan) && (!plan.blockers.length || (cleanupForceable(plan) && forceAcknowledged));
