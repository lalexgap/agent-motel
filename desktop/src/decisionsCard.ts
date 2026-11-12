import { apiGet } from "./api";
import { registerCard } from "./chat";
import { decisionOpener } from "./decisionOpen";
import type { InboxDecision } from "./decisionsInbox";
import { showDecisionsForAgent } from "./decisionsView";
import { h } from "./dom";
import { parseAgentKey } from "./fleet";
import { changed, findRow, state } from "./state";
import { onMainViewChange } from "./views";

declare global {
  interface Window {
    agentDecisions: {
      renderDecisionCard(decisions: InboxDecision[], options: {
        agent: string;
        onAnswer?: (decision: InboxDecision, agent: string) => Promise<void>;
      }): HTMLElement | null;
    };
  }
}

let selected: string | null = null;
let signature = "";
let sequence = 0;
let cardGeneration = 0;
let actionSequence = 0;
let fetchedAt = 0;
let loading = false;
let entries: InboxDecision[] = [];
let error = "";
let actionError = "";
let node: HTMLElement | null = null;
let content = "";

function card(key: string): HTMLElement | null {
  const parsed = parseAgentKey(key);
  const row = findRow(key);
  if (selected !== key) {
    selected = key;
    sequence++;
    cardGeneration++;
    entries = [];
    error = actionError = signature = content = "";
    node = null;
    fetchedAt = 0;
    loading = false;
  }
  if (!parsed || !row || row.host || !row.openDecisions) {
    if (entries.length || loading || signature) {
      sequence++;
      cardGeneration++;
      loading = false;
      entries = [];
      actionError = signature = content = "";
      fetchedAt = 0;
      node = null;
    }
    return null;
  }
  const nextSignature = JSON.stringify([row.openDecisions, row.blockingDecisions, row.firstDecision, row.oldestDecisionAt]);
  if (!loading && (signature !== nextSignature || Date.now() - fetchedAt >= 15000)) {
    signature = nextSignature;
    loading = true;
    fetchedAt = Date.now();
    const request = ++sequence;
    void apiGet<{ decisions: InboxDecision[]; remote?: boolean }>(parsed.connection, `/api/agents/${encodeURIComponent(parsed.id)}/decisions`)
      .then((data) => {
        if (request !== sequence || state.selected !== key) return;
        if (!data || !Array.isArray(data.decisions)) throw new Error("Invalid decisions response");
        entries = data.remote ? [] : data.decisions;
        error = "";
      })
      .catch(() => {
        if (request === sequence && state.selected === key) error = "Could not refresh this agent's decisions.";
      })
      .finally(() => {
        if (request === sequence) {
          loading = false;
          if (state.selected === key) changed("agent");
        }
      });
  }
  const nextContent = JSON.stringify([key, entries, error, actionError, !entries.length && loading]);
  if (content === nextContent) return node;
  content = nextContent;
  node = h("section", "am-agent-decisions-card");
  node.setAttribute("aria-label", "Agent decisions");
  const rendered = window.agentDecisions.renderDecisionCard(entries, {
    agent: row.name,
    onAnswer: async (decision) => {
      const generation = cardGeneration;
      const request = ++actionSequence;
      try {
        await decisionOpener.open({ connection: parsed.connection, agent: row.name, decisionId: decision.id });
        if (generation === cardGeneration && request === actionSequence && selected === key && state.selected === key && actionError) {
          actionError = "";
          changed("agent");
        }
      } catch (cause) {
        if (generation === cardGeneration && request === actionSequence && selected === key && state.selected === key) {
          actionError = cause instanceof Error ? cause.message : "Could not open the decisions page.";
          changed("agent");
        }
        throw cause;
      }
    },
  });
  if (rendered) node.append(rendered);
  else if (loading) node.append(h("p", "", "Loading open decisions…"));
  if (error) node.append(h("p", "decisions-note", error));
  if (actionError) node.append(h("p", "decisions-note decisions-error", actionError));
  const open = h("button", "", "View in Decisions");
  open.type = "button";
  open.onclick = () => showDecisionsForAgent(parsed.connection, row.name);
  node.append(open);
  return node;
}

export function initDecisionsCard(): void {
  registerCard(card);
  onMainViewChange(() => {
    if (selected && selected !== state.selected) {
      selected = null;
      sequence++;
      cardGeneration++;
      loading = false;
    }
  });
}
