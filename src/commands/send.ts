import { hostname } from "node:os";
import { isExactNamesOnly, matchAgent, readAgent, resolveAgent } from "../state";
import { queueAppendForAgent, queueDepth } from "../queue";
import { hasSession, sendText } from "../tmux";
import { acquireDeliverLock, deliverNext, endAbortedTurn, enterDelayMs, escapeTurn, releaseDeliverLock } from "../deliver";
import { attribute, bareName, recordComms, resolveSender } from "../comms";
import { loadConfig } from "../config";
import { outboxAppend, takeBouncesFrom } from "../outbox";
import { immediateMark, queueTrackedMessage, recordImmediateDelivery } from "../messages";

export interface SendResult {
  id: string | null;
}

function say(opts: { json?: boolean }, line: string): void {
  if (!opts.json) console.log(line);
}

function printResult(opts: { json?: boolean }, result: SendResult): SendResult {
  if (opts.json) console.log(JSON.stringify(result));
  return result;
}

function requireLiveSession(prefix: string, exact = false) {
  const agent = exact ? readAgent(prefix) : resolveAgent(prefix);
  if (!agent) throw new Error(`no local agent "${prefix}"`);
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
function outboxFallback(prefix: string, message: string, opts: { from?: string; json?: boolean }): void {
  const from = resolveSender(opts.from);
  const to = bareName(prefix);
  outboxAppend({ to, from, fromHost: hostname(), body: message });
  say(opts, `queued in outbox for "${to}" — delivered when a collector picks it up`);
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
  opts: { now: boolean; from?: string; json?: boolean; track?: boolean },
): Promise<SendResult> {
  const track = opts.track || opts.json;
  const agent = matchAgent(prefix);
  if (!agent && isExactNamesOnly()) throw new Error(`no agent matches "${prefix}"`);
  if (!agent) {
    outboxFallback(prefix, message, opts);
    return printResult(opts, { id: null });
  }
  if (!hasSession(agent.tmuxSession)) {
    throw new Error(`agent "${agent.name}" has no live tmux session (status: ${agent.status})`);
  }
  const from = resolveSender(opts.from);
  const kind = opts.now ? "now" : "send";
  const att = attribute(from, agent.name, message, kind, undefined, { record: false });
  if (!att.allowed) {
    rateLimited(from!, agent.name);
    return printResult(opts, { id: null });
  }
  const body = att.body;

  if (opts.now) {
    if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" mailbox is busy — retry the message`);
    // Inject immediately; the TUI's native mid-turn steering handles the rest.
    let id: string | null = null;
    try {
      if (!readAgent(agent.name)) throw new Error(`agent "${agent.name}" no longer exists — retry the message`);
      const mark = track ? immediateMark(agent) : null;
      sendText(agent.tmuxSession, body, { enterDelayMs: enterDelayMs(agent, body) });
      if (mark) id = recordImmediateDelivery(agent.name, mark, body);
      if (att.attributed) recordComms({ at: new Date().toISOString(), from: from!, to: agent.name, kind, body: message });
    }
    finally { releaseDeliverLock(agent.name); }
    say(opts, `sent to "${agent.name}" (steering current turn)`);
    return printResult(opts, { id });
  }

  const trackedId = track ? queueTrackedMessage(agent.name, body) : null;
  const queuedId = trackedId ? `${trackedId}.json` : queueAppendForAgent(agent.name, body);
  if (att.attributed) recordComms({ at: new Date().toISOString(), from: from!, to: agent.name, kind, body: message });
  if (agent.status === "idle" || agent.status === "starting") {
    // Agent isn't working, so no Stop hook is coming — deliver right away.
    const result = await deliverNext(agent.name);
    if (result.status === "submitted" && result.id === queuedId) {
      say(opts, `delivered to "${agent.name}" (was idle)`);
    } else {
      say(opts, `queued for "${agent.name}" (${queueDepth(agent.name)} in queue) — awaiting delivery`);
    }
  } else {
    say(opts, `queued for "${agent.name}" (${queueDepth(agent.name)} in queue) — delivered when it goes idle`);
  }
  return printResult(opts, { id: trackedId });
}

export async function interruptCommand(
  prefix: string,
  message: string,
  opts: { from?: string; exact?: boolean; json?: boolean; track?: boolean } = {},
): Promise<SendResult> {
  const agent = requireLiveSession(prefix, opts.exact);
  const from = resolveSender(opts.from);
  const att = attribute(from, agent.name, message, "interrupt", undefined, { record: false });
  if (!att.allowed) {
    rateLimited(from!, agent.name);
    return printResult(opts, { id: null });
  }

  if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" mailbox is busy — retry the message`);
  let id: string | null = null;
  try {
    escapeTurn(agent);
    await Bun.sleep(400);
    const mark = opts.track || opts.json ? immediateMark(agent) : null;
    sendText(agent.tmuxSession, att.body, { enterDelayMs: enterDelayMs(agent, att.body) });
    if (mark) id = recordImmediateDelivery(agent.name, mark, att.body);
    if (att.attributed) recordComms({ at: new Date().toISOString(), from: from!, to: agent.name, kind: "interrupt", body: message });
  } finally { releaseDeliverLock(agent.name); }
  say(opts, `interrupted "${agent.name}" with new message`);
  return printResult(opts, { id });
}

export async function abortTurn(name: string): Promise<void> {
  const agent = requireLiveSession(name, true);
  if (!acquireDeliverLock(agent.name)) throw new Error(`agent "${agent.name}" mailbox is busy — retry`);
  const escAt = Date.now();
  try {
    escapeTurn(agent);
  } finally { releaseDeliverLock(agent.name); }
  console.log(`interrupted "${agent.name}"`);
  await endAbortedTurn(agent.name, escAt);
}
