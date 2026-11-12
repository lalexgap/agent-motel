import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { decisionStoreTextFor, parseDecisionStore, readDecisionStoreTextsResult } from "./decisions";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { notify } from "./notify";
import { baseDir } from "./paths";
import { listAgents, type AgentState } from "./state";

const STALE_MS = 48 * 60 * 60 * 1000;
const TICK_MS = 15 * 60 * 1000;
const STATE_VERSION = 1;

export interface DecisionFreshnessSummary {
  staleDecisions: number;
  exitedAgents: number;
  attentionDecisions: number;
  affectedAgents: number;
}

interface DecisionFreshnessState {
  version: number;
  lastRunDay: string;
  lastRunAt: string;
}

type FreshnessConfig = Pick<Config, "decisions" | "gcAutoHour">;

export function decisionFreshnessStateFile(): string {
  return join(baseDir(), "decision-freshness.json");
}

function localDay(now: Date): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function scheduledHour(config: FreshnessConfig): number {
  return Number.isFinite(config.gcAutoHour) && config.gcAutoHour >= 0 && config.gcAutoHour <= 23
    ? Math.floor(config.gcAutoHour)
    : 4;
}

function readState(file: string): DecisionFreshnessState | null {
  const state = readJsonOrNull<DecisionFreshnessState>(file);
  return state?.version === STATE_VERSION && typeof state.lastRunDay === "string" ? state : null;
}

export function decisionFreshnessDue(now: Date, config: FreshnessConfig, state: DecisionFreshnessState | null): boolean {
  return config.decisions !== false && now.getHours() >= scheduledHour(config) && state?.lastRunDay !== localDay(now);
}

export function scanDecisionFreshness(
  now: Date,
  agents: AgentState[] = listAgents(),
  stores: Map<string, string> = readDecisionStoreTexts(),
): DecisionFreshnessSummary {
  const stale = new Set<string>();
  const attention = new Set<string>();
  const exited = new Set<string>();
  const affected = new Set<string>();
  const nowMs = now.getTime();

  for (const agent of agents) {
    const text = decisionStoreTextFor(stores, agent.name);
    const store = text === undefined ? null : parseDecisionStore(text);
    if (!store) continue;
    for (const decision of store.decisions) {
      if (decision.status !== "open") continue;
      const key = `${agent.name}\0${decision.id}`;
      const askedAt = typeof decision.asked_at === "string" ? Date.parse(decision.asked_at) : Number.NaN;
      const isStale = Number.isFinite(askedAt) && nowMs - askedAt > STALE_MS;
      const isExited = agent.status === "exited";
      if (isStale) stale.add(key);
      if (isExited) exited.add(agent.name);
      if (!isStale && !isExited) continue;
      attention.add(key);
      affected.add(agent.name);
    }
  }

  return {
    staleDecisions: stale.size,
    exitedAgents: exited.size,
    attentionDecisions: attention.size,
    affectedAgents: affected.size,
  };
}

export function decisionFreshnessMessage(summary: DecisionFreshnessSummary): string {
  const decisions = `${summary.attentionDecisions} open decision${summary.attentionDecisions === 1 ? "" : "s"}`;
  const agents = `${summary.affectedAgents} agent${summary.affectedAgents === 1 ? "" : "s"}`;
  const stale = `${summary.staleDecisions} over 48h`;
  const exited = `${summary.exitedAgents} exited agent${summary.exitedAgents === 1 ? "" : "s"} with open decisions`;
  return `${decisions} need attention across ${agents} (${stale}; ${exited}) — run am summary`;
}

export interface RunDecisionFreshnessOptions {
  now?: Date;
  config?: FreshnessConfig;
  agents?: AgentState[];
  stores?: Map<string, string> | null;
  storesComplete?: boolean;
  stateFile?: string;
  notify?: (title: string, message: string) => void;
}

export type DecisionFreshnessRun =
  | { status: "disabled" | "not-due" }
  | { status: "ran"; summary: DecisionFreshnessSummary };

export function runDecisionFreshness(options: RunDecisionFreshnessOptions = {}): DecisionFreshnessRun {
  const now = options.now ?? new Date();
  const config = options.config ?? loadConfig();
  if (config.decisions === false) return { status: "disabled" };
  const stateFile = options.stateFile ?? decisionFreshnessStateFile();
  if (!decisionFreshnessDue(now, config, readState(stateFile))) return { status: "not-due" };

  let stores: Map<string, string> | null;
  let storesComplete = options.storesComplete ?? true;
  if (options.stores === undefined) {
    const result = readDecisionStoreTextsResult();
    if (result === null) return { status: "not-due" };
    stores = result.texts;
    storesComplete = result.complete;
  } else {
    stores = options.stores;
  }
  if (stores === null || !storesComplete) return { status: "not-due" };
  const summary = scanDecisionFreshness(now, options.agents, stores);
  writeJsonAtomic(stateFile, { version: STATE_VERSION, lastRunDay: localDay(now), lastRunAt: now.toISOString() }, { durable: true });
  if (summary.attentionDecisions > 0) {
    const publish = options.notify ?? ((title: string, message: string) => notify(title, message, { kind: "attention" }));
    publish("am: decisions need attention", decisionFreshnessMessage(summary));
  }
  return { status: "ran", summary };
}

export function startDecisionFreshness(log: (message: string) => void): { stop(): void } {
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    try {
      runDecisionFreshness();
    } catch (error) {
      log(`decision freshness scan failed: ${error}`);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
