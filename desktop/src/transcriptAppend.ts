import type { TranscriptEntry } from "./types";

// One rendered transcript: the agent, the options it rendered with, and each
// entry's JSON, so a later poll can tell whether it only added entries.
export interface RenderedEntries {
  key: string;
  agentName: string;
  readBoundary: number | null;
  prints: string[];
}

// The entries to append when `next` keeps every rendered entry unchanged and
// only adds more, else null (render everything). Consecutive tool entries
// share one group, so a new tool entry right after a rendered one re-renders.
export function appendedEntries(rendered: RenderedEntries | null, next: RenderedEntries,
                                entries: readonly TranscriptEntry[]): TranscriptEntry[] | null {
  if (!rendered || rendered.key !== next.key || rendered.agentName !== next.agentName ||
      rendered.readBoundary !== next.readBoundary) return null;
  const count = rendered.prints.length;
  if (!count || next.prints.length <= count || entries.length !== next.prints.length) return null;
  for (let index = 0; index < count; index++) if (rendered.prints[index] !== next.prints[index]) return null;
  if (entries[count - 1]?.kind === "tool" && entries[count]?.kind === "tool") return null;
  return entries.slice(count);
}
