import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { decisionsHome, parseOpenDecisions, readDecisionStoreTextsResult, type OpenDecision } from "./decisions";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { notify } from "./notify";
import { baseDir } from "./paths";

// One notification per decision an agent opens (`decision add`), so a question
// for Alex surfaces when it's asked rather than at the nightly reminder. The
// store belongs to the decisions skill; am only reads it.

const TICK_MS = 10_000;
const STATE_VERSION = 1;
// More new decisions than this at once (a store moved with a renamed agent,
// say) collapse into one notification.
const MAX_INDIVIDUAL = 3;

export interface DecisionRequest {
  agent: string;
  decision: OpenDecision;
}

interface SeenState {
  version: number;
  // Open decision ids per store, as of the last scan.
  open: Record<string, string[]>;
}

export function decisionRequestsStateFile(): string {
  return join(baseDir(), "decision-requests.json");
}

// No previous scan seeds the state silently, so a first start doesn't announce
// every decision already open. Pure.
export function planDecisionRequests(
  stores: Map<string, string>,
  previous: Record<string, string[]> | null,
): { fresh: DecisionRequest[]; open: Record<string, string[]> } {
  const open: Record<string, string[]> = {};
  const fresh: DecisionRequest[] = [];
  for (const [agent, text] of stores) {
    const decisions = parseOpenDecisions(text);
    if (decisions.length === 0) continue;
    open[agent] = decisions.map((d) => d.id);
    if (!previous) continue;
    const seen = new Set(previous[agent] ?? []);
    for (const decision of decisions) if (!seen.has(decision.id)) fresh.push({ agent, decision });
  }
  return { fresh, open };
}

export function decisionRequestMessage(decision: OpenDecision): string {
  return `${decision.blocking ? "blocking decision" : "decision"} needed: ${decision.question}`;
}

export function runDecisionRequests(options: {
  stateFile?: string;
  stores?: Map<string, string>;
  publish?: (title: string, message: string, meta: { agent?: string; url?: string }) => void;
} = {}): DecisionRequest[] {
  if (loadConfig().decisions === false) return [];
  let stores = options.stores;
  if (!stores) {
    // No folder yet is an empty scan, so the first decision ever opened here is announced.
    const result = existsSync(decisionsHome()) ? readDecisionStoreTextsResult() : { texts: new Map<string, string>(), complete: true };
    // A store that failed to read would look like its decisions were answered.
    if (!result?.complete) return [];
    stores = result.texts;
  }
  const stateFile = options.stateFile ?? decisionRequestsStateFile();
  const state = readJsonOrNull<SeenState>(stateFile);
  const previous = state?.version === STATE_VERSION && state.open && typeof state.open === "object" ? state.open : null;
  const { fresh, open } = planDecisionRequests(stores, previous);
  if (!previous || JSON.stringify(previous) !== JSON.stringify(open)) writeJsonAtomic(stateFile, { version: STATE_VERSION, open });
  const publish = options.publish ?? ((title, message, meta) => notify(title, message, { ...meta, kind: "decision" }));
  if (fresh.length > MAX_INDIVIDUAL) {
    const agents = [...new Set(fresh.map((r) => r.agent))];
    publish("am: decisions needed", `${fresh.length} new decisions from ${agents.slice(0, 4).join(", ")}${agents.length > 4 ? ", …" : ""}`, {});
  } else {
    for (const { agent, decision } of fresh) {
      publish(`am: ${agent}`, decisionRequestMessage(decision), { agent, ...(decision.prs[0] ? { url: decision.prs[0] } : {}) });
    }
  }
  return fresh;
}

export function startDecisionRequests(log: (message: string) => void): { stop(): void } {
  const tick = () => {
    try {
      runDecisionRequests();
    } catch (error) {
      log(`decision request scan failed: ${error}`);
    }
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  return { stop: () => clearInterval(timer) };
}
