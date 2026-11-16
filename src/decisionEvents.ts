import { readDecisionStoreTextsIfAvailable } from "./decisions";

// The CLI and drop page atomically replace stores outside the daemon. Compare
// contents so same-count edits and chat resolutions also invalidate clients.
export function startDecisionEvents(
  publish: (event: string, agent?: string) => void,
  read = readDecisionStoreTextsIfAvailable,
  intervalMs = 1000,
): { stop(): void; scan(): void } {
  let previous = read() ?? new Map<string, string>();
  const scan = () => {
    const current = read();
    if (current === null) return;
    for (const agent of new Set([...previous.keys(), ...current.keys()])) {
      if (previous.get(agent) !== current.get(agent)) publish("decisions-changed", agent);
    }
    previous = current;
  };
  const timer = setInterval(scan, intervalMs);
  return { scan, stop: () => clearInterval(timer) };
}
