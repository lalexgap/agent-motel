import { showDecisionsForAgent } from "./decisionsView";
import { h } from "./dom";
import { parseAgentKey, rowStatusLabel } from "./fleet";
import { registerInspectorSection } from "./inspector";
import { elapsed } from "./ordering";
import { showPrs } from "./prsView";
import { agentSource } from "./state";
import { activeSubagentCount } from "./ordering";
import { projectionMessage } from "./statusModel";
import type { AgentRow } from "./types";

function age(iso?: string): string {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? `${elapsed(Math.max(0, Date.now() - at))} ago` : "age unknown";
}

function labelled(title: string, text: string): HTMLElement {
  const block = h("div", "am-status-block");
  block.append(h("h3", "", title), h("p", "", text));
  return block;
}

function signal(text: string): HTMLElement {
  return h("span", "am-status-signal", text);
}

function render(key: string): HTMLElement {
  const row = agentSource(key) as Partial<AgentRow>;
  const projection = row.statusProjection;
  const box = h("div", "am-status-summary");
  if (projection?.state === "available") {
    box.append(labelled("Current status", projection.currentStatus || "Status unavailable"));
    if (projection.nextSteps) box.append(labelled("Next steps", projection.nextSteps));
  } else {
    box.append(h("p", "am-insp-note", projectionMessage(projection)));
    if (row.task) box.append(labelled("Original task — not current status", row.task));
  }
  box.append(h("p", "am-status-freshness", projection?.modifiedAt
    ? `Plan file modified ${age(projection.modifiedAt)} · summary freshness unknown`
    : "Summary freshness unknown"));

  const signals = h("div", "am-status-signals");
  signals.append(signal(`${rowStatusLabel(row as AgentRow)} · state since ${age(row.statusChangedAt || row.updatedAt)}`));
  const subagents = activeSubagentCount(row as AgentRow);
  const subagentsKnown = (row as { capabilities?: { subagents?: unknown } }).capabilities?.subagents === true
    || row.subagents !== undefined || row.busyWith !== undefined;
  signals.append(signal(subagents ? `${subagents} active subagent${subagents === 1 ? "" : "s"}` : subagentsKnown ? "No active subagents reported" : "Subagent availability unknown"));
  if ((row.openDecisions ?? 0) > 0) {
    const parsed = parseAgentKey(key);
    const button = h("button", "am-status-signal", `${row.openDecisions} open decision${row.openDecisions === 1 ? "" : "s"}`);
    button.type = "button";
    button.onclick = () => { if (parsed) showDecisionsForAgent(parsed.connection, parsed.id); };
    signals.append(button);
  } else signals.append(signal(row.openDecisions === 0 ? "No open decisions reported" : "Decision state unavailable"));
  const prs = row.prStatus ?? [];
  const monitoredPrs = row.prMonitor?.pullRequests ?? [];
  if (prs.length) {
    const button = h("button", "am-status-signal", `${prs.length} registered PR${prs.length === 1 ? "" : "s"} · observed ${age(row.prMonitor?.checkedAt)}`);
    button.type = "button";
    button.title = prs.map((pr) => `#${pr.number} ${pr.state}: ${pr.reason}`).join("\n");
    button.onclick = showPrs;
    signals.append(button);
  } else if (monitoredPrs.length) {
    const button = h("button", "am-status-signal", `${monitoredPrs.length} registered PR${monitoredPrs.length === 1 ? "" : "s"} · detailed state unavailable`);
    button.type = "button";
    button.title = monitoredPrs.map((pr) => `#${pr.number} ${pr.state.toLowerCase()}`).join("\n");
    button.onclick = showPrs;
    signals.append(button);
  } else if (row.prMonitor) signals.append(signal(`No registered PRs · checked ${age(row.prMonitor.checkedAt)}`));
  else signals.append(signal("Registered PR state unavailable"));
  box.append(signals);
  return box;
}

export function initStatusSection(): void {
  registerInspectorSection({ id: "status", title: "Task status", order: 10, render });
}
