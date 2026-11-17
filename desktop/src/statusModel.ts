import type { AgentRow, PlanProjection } from "./types";

export function statusSummary(row: Partial<AgentRow>): string {
  const projection = row.statusProjection;
  if (projection?.state === "available" && projection.currentStatus) {
    return projection.currentStatus.split("\n").find((line) => line.trim())?.trim() || "Status unavailable";
  }
  const task = row.task?.split("\n")[0]?.trim();
  if (projection?.state === "placeholder") return task ? `Plan says not started · Original task: ${task}` : "Plan says not started";
  if (projection?.state === "missing") return task ? `Original task: ${task}` : "No plan available";
  if (!projection) return "Status unavailable on this host";
  return task ? `Original task: ${task}` : "Status unavailable";
}

export function projectionMessage(projection: PlanProjection | undefined): string {
  if (!projection) return "This host does not provide a plan status projection.";
  if (projection.state === "missing") return "No running plan was found for this agent.";
  if (projection.state === "placeholder") return "The running plan still says this task has not started.";
  if (projection.reason === "too-large") return "The running plan is too large to project safely.";
  if (projection.reason === "duplicate-headings") return "The running plan has duplicate status headings.";
  if (projection.reason === "unsafe-path") return "The running plan was refused because its path is unsafe.";
  if (projection.state === "invalid") return "The running plan does not have readable status headings.";
  return "The running plan could not be read.";
}
