import { hostname } from "node:os";
import { matchAgent, readAgent, resolveAgent } from "../state";
import { queueAppendForAgent, queueDepth } from "../queue";
import { hasSession, sendEscape, sendText } from "../tmux";
import { acquireDeliverLock, deliverNext, enterDelayMs, releaseDeliverLock } from "../deliver";
import { attribute, bareName, recordComms, resolveSender } from "../comms";
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
function outboxFallback(prefix: string, message: string, opts: { from?: string; quiet?: boolean }): SendOutcome {
  const from = resolveSender(opts.from);
  const to = bareName(prefix);
  outboxAppend({ to, from, fromHost: hostname(), body: message });
  if (!opts.quiet) console.log(`queued in outbox for "${to}" — delivered when a collector picks it up`);
  for (const b of from ? takeBouncesFrom(from) : []) {
    console.error(
      `note: your earlier message to "${b.to}" expired undelivered (queued ${b.queuedAt}, never collected)`,
    );
  }
  return "outbox";
}

// Drop notice when a send trips the per-pair rate limiter — surfaced so a
// looping agent (or a human) sees why the message vanished.
function rateLimited(from: string, to: string): SendOutcome {
  const cfg = loadConfig();
  console.error(
    `am: dropped message from "${from}" to "${to}" — over the rate limit ` +
      `(${cfg.commsMaxPerWindow}/${cfg.commsWindowSeconds}s). Possible message loop.`,
  );
  return "dropped";
}

// How a send landed: injected mid-turn, delivered to an idle agent, queued
// for its next idle, parked in the outbox, or dropped by the rate limiter.
export type SendOutcome = "steered" | "delivered" | "queued" | "outbox" | "dropped";

// quiet: in-UI callers report the returned outcome themselves.
export async function sendCommand(
  prefix: string,
  message: string,
  opts: { now: boolean; from?: string; quiet?: boolean },
): Promise<SendOutcome> {
  const log = (line: string) => { if (!opts.quiet) console.log(line); };
  const agent = matchAgent(prefix);
  if (!agent) return outboxFallback(prefix, message, opts);
  if (!hasSession(agent.tmuxSession)) {
    throw new Error(`agent "${agent.name}" has no live tmux session (status: ${agent.status})`);
  }
  const from = resolveSender(opts.from);
  const kind = opts.now ? "now" : "send";
  const att = attribute(from, agent.name, message, kind, undefined, { record: false });
  if (!att.allowed) return rateLimited(from!, agent.name);
  const body = att.body;

  if (opts.now) {
    if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" mailbox is busy — retry the message`);
    // Inject immediately; the TUI's native mid-turn steering handles the rest.
    try {
      if (!readAgent(agent.name)) throw new Error(`agent "${agent.name}" no longer exists — retry the message`);
      sendText(agent.tmuxSession, body, { enterDelayMs: enterDelayMs(agent, body) });
      if (att.attributed) recordComms({ at: new Date().toISOString(), from: from!, to: agent.name, kind, body: message });
    }
    finally { releaseDeliverLock(agent.name); }
    log(`sent to "${agent.name}" (steering current turn)`);
    return "steered";
  }

  const queuedId = queueAppendForAgent(agent.name, body);
  if (att.attributed) recordComms({ at: new Date().toISOString(), from: from!, to: agent.name, kind, body: message });
  if (agent.status === "idle" || agent.status === "starting") {
    // Agent isn't working, so no Stop hook is coming — deliver right away.
    const result = await deliverNext(agent.name);
    if (result.status === "submitted" && result.id === queuedId) {
      log(`delivered to "${agent.name}" (was idle)`);
      return "delivered";
    }
    log(`queued for "${agent.name}" (${queueDepth(agent.name)} in queue) — awaiting delivery`);
  } else {
    log(`queued for "${agent.name}" (${queueDepth(agent.name)} in queue) — delivered when it goes idle`);
  }
  return "queued";
}

export async function interruptCommand(
  prefix: string,
  message: string,
  opts: { from?: string } = {},
): Promise<void> {
  const agent = requireLiveSession(prefix);
  const from = resolveSender(opts.from);
  const att = attribute(from, agent.name, message, "interrupt", undefined, { record: false });
  if (!att.allowed) { rateLimited(from!, agent.name); return; }

  if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" mailbox is busy — retry the message`);
  try {
    sendEscape(agent.tmuxSession);
    await Bun.sleep(400);
    sendText(agent.tmuxSession, att.body, { enterDelayMs: enterDelayMs(agent, att.body) });
    if (att.attributed) recordComms({ at: new Date().toISOString(), from: from!, to: agent.name, kind: "interrupt", body: message });
  } finally { releaseDeliverLock(agent.name); }
  console.log(`interrupted "${agent.name}" with new message`);
}
