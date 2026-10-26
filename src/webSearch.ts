import { createReadStream } from "node:fs";
import { agentProvider, listAgents, type Provider } from "./state";
import { entryFragments, locateTranscript, type Fragment } from "./transcript";

export interface ConversationMatches {
  matches: { name: string; host?: string; snippets: Fragment[] }[];
  partial: boolean;
}
export function validSearchQuery(query: unknown): query is string {
  return typeof query === "string" && query.trim().length >= 2 && query.length <= 256 && !query.includes("\0");
}

export async function scanConversation(file: string, provider: Provider, query: string, signal: AbortSignal) {
  const snippets: Fragment[] = [];
  let pending = "", skipping = false, partial = false;
  const needle = query.toLowerCase();
  const consume = (line: string) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    if (!entry || typeof entry !== "object") return;
    for (const fragment of entryFragments(provider, entry)) {
      const index = fragment.text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - 90), end = Math.min(fragment.text.length, index + query.length + 150);
      snippets.push({ kind: fragment.kind, text: (start ? "…" : "") + fragment.text.slice(start, end) + (end < fragment.text.length ? "…" : "") });
      if (snippets.length === 3) break;
    }
  };
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, signal })) {
    for (const [index, part] of String(chunk).split("\n").entries()) {
      if (index) {
        if (!skipping) consume(pending);
        pending = ""; skipping = false;
        if (snippets.length >= 3) return { snippets, partial };
      }
      if (!skipping) {
        pending += part;
        if (pending.length > 1024 * 1024) { pending = ""; skipping = true; partial = true; }
      }
    }
  }
  if (!skipping && pending && snippets.length < 3) consume(pending);
  return { snippets, partial };
}

export async function searchConversations(query: string): Promise<ConversationMatches> {
  if (!validSearchQuery(query)) throw new Error("Search must contain 2–256 characters");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const result: ConversationMatches = { matches: [], partial: false };
  try {
    for (const agent of listAgents()) {
      if (controller.signal.aborted || result.matches.length >= 100) { result.partial = true; break; }
      let file;
      try { file = locateTranscript(agent); } catch { continue; }
      try {
        const found = await scanConversation(file, agentProvider(agent), query.trim(), controller.signal);
        result.partial ||= found.partial;
        if (found.snippets.length) result.matches.push({ name: agent.name, snippets: found.snippets });
      } catch { result.partial = true; }
    }
    return result;
  } finally { clearTimeout(timer); }
}
