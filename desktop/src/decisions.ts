// Open decisions an agent registered for the owner, as fleet rows carry them.
// Read-only wording; tests/desktopDecisions.test.ts pins it to `am ls`.
import { relativeTime } from "./format";
import type { AgentRow } from "./types";

type DecisionFields = Pick<AgentRow, "openDecisions" | "blockingDecisions" | "oldestDecisionAt" | "firstDecision">;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
// Missing (a remote am that predates them) is none.
export const openDecisions = (row: DecisionFields): number => count(row.openDecisions);
export const blockingDecisions = (row: DecisionFields): number => Math.min(count(row.blockingDecisions), openDecisions(row));

const noun = (open: number): string => `${open} decision${open === 1 ? "" : "s"}`;

// am's `decisionsLabel`: "2 decisions", "1 decision (blocking)", "3 decisions (1 blocking)".
export function decisionsLabel(open: number, blocking: number): string {
  if (blocking === 0) return noun(open);
  return blocking === open ? `${noun(open)} (blocking)` : `${noun(open)} (${blocking} blocking)`;
}
export const rowDecisionsLabel = (row: DecisionFields): string =>
  openDecisions(row) ? decisionsLabel(openDecisions(row), blockingDecisions(row)) : "";

export const decisionsWaiting = (row: DecisionFields): string =>
  openDecisions(row) ? `${noun(openDecisions(row))} waiting on you` : "";
export function decisionsName(row: DecisionFields): string {
  const label = decisionsWaiting(row);
  const question = (row.firstDecision || "").trim();
  return label && question ? `${label}: ${question}` : label;
}
export function decisionsTitle(row: DecisionFields, now = Date.now()): string {
  if (!openDecisions(row)) return "";
  const asked = relativeTime(row.oldestDecisionAt, now);
  const when = !asked ? "" : asked === "now" ? "asked just now" : `asked ${asked} ago`;
  return [decisionsWaiting(row), (row.firstDecision || "").trim(), when].filter(Boolean).join("\n");
}

export function agentsWaitingOnDecisions(rows: Iterable<DecisionFields>): string {
  let agents = 0;
  for (const row of rows) if (openDecisions(row)) agents++;
  return agents ? `${agents} agent${agents === 1 ? "" : "s"} waiting on decisions` : "";
}
