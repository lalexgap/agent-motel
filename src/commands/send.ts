import { hostname } from "node:os";
import { matchAgent, resolveAgent } from "../state";
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
  const agent = matchAgent(prefix);
  if (!agent) return outboxFallback(prefix, message, opts);
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

  queueAppend(agent.name, body);
  if (agent.status === "idle" || agent.status === "starting") {
    // Agent isn't working, so no Stop hook is coming — deliver right away.
    await deliverNext(agent.name);
    console.log(`delivered to "${agent.name}" (was idle)`);
  } else {
    console.log(`queued for "${agent.name}" (${queueDepth(agent.name)} in queue) — delivered when it goes idle`);
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
