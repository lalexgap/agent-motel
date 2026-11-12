// The inspector's "Agents & subagents" section, after the browser UI's
// renderRelated: the AM agent that spawned this one, the AM agents it spawned,
// and its built-in subagents (running first, then newest), with "Show finished".
import { selectAgent } from "./chat";
import { dot, h } from "./dom";
import { agentKey, parseAgentKey, statusLabel, STOPPED } from "./fleet";
import { inspectorPrefs, registerInspectorSection, renderInspector, saveInspectorPrefs } from "./inspector";
import { findRow, isConcierge, state, type DetailState } from "./state";
import {
  childRows,
  parentKeyOf,
  runningOf,
  SUBAGENT_STATUS,
  subagentKey,
  subagentLabel,
  subagentsAvailable,
  subagentState,
  tokenText,
  visibleSubagents,
  type SubagentState,
} from "./subagents";
import { openSubagent } from "./subagentView";
import type { AgentRow, SubagentRecord } from "./types";

const PROVIDER_NAME: Record<string, string> = { antigravity: "Antigravity", claude: "Claude", codex: "Codex" };

function agentLink(row: AgentRow | null, key: string, kind: string, focusKey: string): HTMLElement {
  const name = isConcierge(key) ? "Concierge" : row?.name ?? parseAgentKey(key)?.id ?? key;
  if (!row) {
    // Not in the fleet any more: say so, with nothing to open.
    const node = h("div", "am-rel-item am-rel-gone");
    const line = h("div", "am-rel-line");
    line.append(h("span", "am-rel-name", name));
    node.append(h("span", "am-rel-kind", kind), line, h("div", "am-rel-meta", "Not in the fleet"));
    return node;
  }
  const button = h("button", `am-rel-item am-rel-agent${STOPPED.has(row.status) ? " stopped" : ""}`);
  button.type = "button";
  button.dataset.focusKey = focusKey;
  button.title = `Open ${name}`;
  const line = h("div", "am-rel-line");
  line.append(dot(row.status), h("span", "am-rel-name", name));
  const meta = h("div", "am-rel-meta");
  meta.append(h("span", "", "AM agent"), h("span", "", statusLabel(row.status)));
  button.append(h("span", "am-rel-kind", kind), line, meta);
  button.addEventListener("click", () => selectAgent(key));
  return button;
}

const STATE_DOT: Record<SubagentState, string> = { running: "working", finished: "exited", stale: "dead" };

function subagentLink(key: string, item: { id: string; label: string; state: SubagentState; tokens: string | null }): HTMLElement {
  const button = h("button", `am-rel-item am-rel-sub s-${item.state}`);
  button.type = "button";
  button.dataset.focusKey = `sub:${item.id}`;
  button.title = `${item.label} · read the transcript`;
  if (state.subagent === subagentKey(key, item.id)) button.setAttribute("aria-current", "true");
  const line = h("div", "am-rel-line");
  line.append(h("span", "am-subagent-mark", "↳"), h("span", "am-rel-name am-rel-label", item.label));
  const meta = h("div", "am-rel-meta");
  const status = h("span", "am-rel-status");
  status.append(dot(STATE_DOT[item.state]), document.createTextNode(SUBAGENT_STATUS[item.state]));
  meta.append(h("span", "", "built-in"));
  if (item.tokens) meta.append(h("span", "", item.tokens));
  meta.append(status);
  button.append(line, meta);
  button.addEventListener("click", () => openSubagent(key, item.id, item.label, SUBAGENT_STATUS[item.state]));
  return button;
}

function render(key: string, detail: DetailState | null): HTMLElement | null {
  const parsed = parseAgentKey(key);
  const conn = parsed ? state.conns.get(parsed.connection) : undefined;
  if (!parsed || !conn) return null;
  const showFinished = inspectorPrefs.showFinished;
  const row = findRow(key);
  const box = h("div", "am-related");
  const parent = row ? parentKeyOf(conn.conn.id, row) : null;
  if (parent) box.append(agentLink(findRow(parent), parent, "Parent agent", "parent"));
  for (const child of childRows(conn.conn.id, conn.rows, key, showFinished)) {
    const childKey = agentKey(conn.conn.id, child);
    box.append(agentLink(child, childKey, "Child agent", `child:${childKey}`));
  }

  const agent = detail?.detail ?? row;
  const capable = detail?.detail ? subagentsAvailable(detail.detail) : row ? subagentsAvailable({ provider: row.provider }) : true;
  const records: SubagentRecord[] | null = detail?.subagents ?? null;
  let hidden = 0;
  if (!capable) {
    box.append(h("p", "am-insp-note", `${PROVIDER_NAME[agent?.provider ?? ""] ?? "This"} agents don't report built-in subagents.`));
  } else if (records === null) {
    // Until the records load, the fleet row's running list stands in.
    for (const sub of row ? runningOf(row) : []) box.append(subagentLink(key, { id: sub.id, label: subagentLabel(sub), state: "running", tokens: null }));
    if (!box.childElementCount) box.append(h("p", "am-insp-note", "Loading subagents…"));
  } else {
    const visible = visibleSubagents(records, showFinished);
    hidden = records.length - visible.length;
    for (const record of visible) {
      box.append(subagentLink(key, { id: record.id, label: subagentLabel(record), state: subagentState(record, agent?.status), tokens: tokenText(record.tokens) }));
    }
  }
  if (detail?.subagentsError) box.append(h("p", "am-insp-error", detail.subagentsError));
  if (!box.childElementCount) box.append(h("p", "am-insp-note", showFinished ? "No subagents recorded." : "No active subagents."));
  if (hidden > 0) box.append(h("p", "am-insp-foot", `${hidden} finished subagent${hidden === 1 ? "" : "s"} hidden`));
  return box;
}

function accessory(): HTMLElement {
  const toggle = h("button", "am-chip am-insp-toggle", "Show finished");
  toggle.type = "button";
  toggle.dataset.focusKey = "show-finished";
  toggle.setAttribute("aria-pressed", String(inspectorPrefs.showFinished));
  toggle.title = "Also list finished subagents and stopped child agents";
  toggle.addEventListener("click", () => {
    inspectorPrefs.showFinished = !inspectorPrefs.showFinished;
    saveInspectorPrefs();
    renderInspector();
  });
  return toggle;
}

export function initRelatedSection(): void {
  registerInspectorSection({ id: "related", title: "Agents & subagents", order: 40, render, accessory });
}
