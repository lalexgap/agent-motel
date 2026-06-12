import { resolveAgent } from "../state";
import { queueAppend, queueDepth } from "../queue";
import { hasSession, sendEscape, sendText } from "../tmux";
import { deliverNext, enterDelayMs } from "../deliver";
import { attribute, resolveSender } from "../comms";
import { loadConfig } from "../config";

function requireLiveSession(prefix: string) {
  const agent = resolveAgent(prefix);
  if (!hasSession(agent.tmuxSession)) {
    throw new Error(`agent "${agent.name}" has no live tmux session (status: ${agent.status})`);
  }
  return agent;
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

export function sendCommand(
  prefix: string,
  message: string,
  opts: { now: boolean; from?: string },
): void {
  const agent = requireLiveSession(prefix);
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
  if (agent.status === "idle" || agent.status === "starting") {
    // Agent isn't working, so no Stop hook is coming — deliver right away.
    deliverNext(agent.name);
    console.log(`delivered to "${agent.name}" (was idle)`);
  } else {
    console.log(`queued for "${agent.name}" (${depth} in queue) — delivered when it goes idle`);
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
