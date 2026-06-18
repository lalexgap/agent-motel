import { hostname } from "node:os";
import { listAgents, readAgent, resolveAgent } from "../state";
import { queueAppend, queueDepth } from "../queue";
import { hasSession, sendEscape, sendText } from "../tmux";
import { deliverNext, enterDelayMs } from "../deliver";
import { attribute, bareName, resolveSender } from "../comms";
import { loadConfig } from "../config";
import { outboxAppend, takeBouncesFrom } from "../outbox";

function requireLiveSession(prefix: string) {
  const agent = resolveAgent(prefix);
  if (!hasSession(agent.tmuxSession)) {
    throw new Error(`agent "${agent.name}" has no live tmux session (status: ${agent.status})`);
  }
  return agent;
}

// Like resolveAgent, but a no-match returns null (the caller stores it in the
// outbox) while an ambiguous prefix still errors.
function localMatch(prefix: string): string | null {
  const names = listAgents().map((a) => a.name);
  if (names.includes(prefix)) return prefix;
  const matches = names.filter((n) => n.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${prefix}" is ambiguous: ${matches.join(", ")}`);
  return null;
}

// No local agent and (the fleet forward already declined) no reachable remote:
// queue for store-and-forward instead of erroring. A collector that owns this
// name sweeps it out. Surfaces any of this sender's messages that expired
// undelivered, so a bounce is never silent.
function outboxFallback(prefix: string, message: string, opts: { from?: string }): void {
  const from = resolveSender(opts.from);
  const to = bareName(prefix);
  outboxAppend({ to, from, fromHost: hostname(), body: message });
  console.log(`queued in outbox for "${to}" — delivered when a collector picks it up`);
  for (const b of from ? takeBouncesFrom(from) : []) {
    console.error(
      `note: your earlier message to "${b.to}" expired undelivered (queued ${b.queuedAt}, never collected)`,
    );
  }
}

// Drop notice when a send trips the per-pair rate limiter — surfaced so a
// looping agent (or a human) sees why the message vanished.
function rateLimited(from: string, to: string): void {
  const cfg = loadConfig();
  console.error(
    `am: dropped message from "${from}" to "${to}" — over the rate limit ` +
      `(${cfg.commsMaxPerWindow}/${cfg.commsWindowSeconds}s). Possible message loop.`,
  );
}

export async function sendCommand(
  prefix: string,
  message: string,
  opts: { now: boolean; from?: string },
): Promise<void> {
  const match = localMatch(prefix);
  if (!match) return outboxFallback(prefix, message, opts);
  const agent = readAgent(match)!;
  if (!hasSession(agent.tmuxSession)) {
    throw new Error(`agent "${agent.name}" has no live tmux session (status: ${agent.status})`);
  }
  const from = resolveSender(opts.from);
  const att = attribute(from, agent.name, message, opts.now ? "now" : "send");
  if (!att.allowed) return rateLimited(from!, agent.name);
  const body = att.body;

  if (opts.now) {
    // Inject immediately; the TUI's native mid-turn steering handles the rest.
    sendText(agent.tmuxSession, body, { enterDelayMs: enterDelayMs(agent) });
    console.log(`sent to "${agent.name}" (steering current turn)`);
    return;
  }

  const depth = queueAppend(agent.name, body);
  // Always attempt delivery: deliverNext reads the pane and only types when the
  // agent is genuinely idle (no "esc to interrupt" footer, empty input box), so
  // this lands immediately even when the status file still says "working" after
  // a missed Stop hook. A truly busy agent gets it on its next Stop / the
  // daemon's reconcile sweep.
  if (await deliverNext(agent.name)) {
    console.log(`delivered to "${agent.name}"`);
  } else {
    console.log(`queued for "${agent.name}" (${depth} in queue) — delivered when it's free`);
  }
}

export async function interruptCommand(
  prefix: string,
  message: string,
  opts: { from?: string } = {},
): Promise<void> {
  const agent = requireLiveSession(prefix);
  const from = resolveSender(opts.from);
  const att = attribute(from, agent.name, message, "interrupt");
  if (!att.allowed) return rateLimited(from!, agent.name);

  sendEscape(agent.tmuxSession);
  await Bun.sleep(400);
  sendText(agent.tmuxSession, att.body, { enterDelayMs: enterDelayMs(agent) });
  console.log(`interrupted "${agent.name}" with new message`);
}
