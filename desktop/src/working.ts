import type { AgentRow } from "./types";

export interface WorkingIndicator {
  label: string;
  anchor?: number;
  text: string;
  attention: boolean;
}

const timestamp = (value: string | null | undefined): number | undefined => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

const subagentCount = (row: Partial<AgentRow>): number => {
  const count = row.busyWith?.subagents;
  return typeof count === "number" && count > 0 ? count : 0;
};

const waitingOnSubagents = (row: Partial<AgentRow>): boolean =>
  row.status === "working" && subagentCount(row) > 0;

export function workingAnchor(row: Partial<AgentRow>): number | undefined {
  if (row.status === "starting" || waitingOnSubagents(row)) {
    return timestamp(row.statusChangedAt);
  }
  if (row.status !== "working" && row.status !== "waiting") return undefined;
  return timestamp(row.workingSince) ?? timestamp(row.promptAt) ?? timestamp(row.statusChangedAt);
}

export function workingText(label: string, since: number | undefined, now: number): string {
  if (since === undefined || !Number.isFinite(since) || !Number.isFinite(now) || since > now || now - since < 2_000) return `${label}…`;
  const seconds = Math.floor((now - since) / 1_000);
  if (seconds < 60) return `${label} · ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${label} · ${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${label} · ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function busyLabel(row: Partial<AgentRow>): string {
  if (row.status === "starting") return "Starting";
  if (row.status === "waiting") return "Waiting on background tasks";
  const count = subagentCount(row);
  if (row.status === "working" && count > 0) {
    const types = (row.subagents?.running ?? [])
      .map((subagent) => subagent.type?.trim())
      .filter((type): type is string => !!type);
    if (count === 1 && types.length === 1) return `Waiting on ${types[0]}`;
    return `Waiting on ${count} subagent${count === 1 ? "" : "s"}`;
  }
  return "Working";
}

export function workingIndicator(row: Partial<AgentRow>, now: number): WorkingIndicator | null {
  if (row.status === "needs-attention") {
    const label = row.statusReason?.trim() || "Needs attention";
    return { label, text: label, attention: true };
  }
  if ((row.blockingDecisions ?? 0) > 0) {
    return { label: "Waiting for your answer", text: "Waiting for your answer", attention: true };
  }
  if (!(["starting", "working", "waiting"] as const).includes(row.status as "starting" | "working" | "waiting")) {
    return null;
  }
  const label = busyLabel(row);
  const anchor = workingAnchor(row);
  return { label, anchor, text: workingText(label, anchor, now), attention: false };
}
