import { agentProvider, agentSessionId, type AgentState, type Provider } from "./state";
import { locateTranscript } from "./transcript";
import { readFileTail } from "./fsutil";

export interface RuntimeSettings {
  model: string | null;
  effort: string | null;
  modelSource: "session" | "configured" | "unknown";
  effortSource: "session" | "configured" | "unknown";
}
const value = (input: unknown): string | null => typeof input === "string" && input.length > 0 && input.length <= 128 && input !== "<synthetic>" ? input : null;

export function parseRuntimeSettings(jsonl: string, provider: Provider): { model: string | null; effort: string | null } {
  let model: string | null = null, effort: string | null = null;
  for (const line of jsonl.split("\n").reverse()) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    if (provider === "codex" && entry.type === "turn_context") {
      return { model: value(entry.payload?.model), effort: value(entry.payload?.effort) ?? value(entry.payload?.reasoning_effort) };
    }
    if (provider === "claude" && entry.type === "assistant" && entry.isSidechain !== true) {
      model = value(entry.message?.model);
      if (model) return { model, effort };
    }
  }
  return { model, effort };
}

const cache = new Map<string, { at: number; result: RuntimeSettings }>();
export function agentRuntimeSettings(agent: AgentState): RuntimeSettings {
  const provider = agentProvider(agent);
  const key = JSON.stringify([agent.name, agent.createdAt, provider, agentSessionId(agent), agent.transcriptPath, agent.model, agent.effort]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.result;
  let observed = { model: null, effort: null } as ReturnType<typeof parseRuntimeSettings>;
  try { observed = parseRuntimeSettings(readFileTail(locateTranscript(agent), 4 * 1024 * 1024) ?? "", provider); } catch {}
  const configuredModel = value(agent.model), configuredEffort = value(agent.effort);
  const result: RuntimeSettings = {
    model: observed.model ?? configuredModel,
    effort: observed.effort ?? configuredEffort,
    modelSource: observed.model ? "session" : configuredModel ? "configured" : "unknown",
    effortSource: observed.effort ? "session" : configuredEffort ? "configured" : "unknown",
  };
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), result });
  return result;
}
