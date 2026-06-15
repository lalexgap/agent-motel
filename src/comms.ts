import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { commsLogFile, ensureDirs } from "./paths";
import { loadConfig } from "./config";

// Inter-agent communication: attribution, the envelope recipients see, and a
// file-backed ledger that powers loop protection + the `am comms` audit view.
// Built on top of the existing queue/deliver path — nothing here moves bytes,
// it only decides what gets stamped onto a message and whether it's allowed.

export type CommsKind = "send" | "now" | "interrupt" | "report";

export interface CommsEntry {
  at: string;
  from: string; // sender, possibly host-qualified (e.g. "laptop:api")
  to: string; // local target name
  kind: CommsKind;
  body: string;
  msgId?: string; // stable id, when the message carried one (dedup index)
}

// The sender of a message originating inside a managed session: any `am`
// invocation there runs with AGENTMGR_AGENT set. An explicit --from wins (the
// daemon, the HTTP API, and ssh-forwarded sends set it because the env doesn't
// survive those hops).
export function resolveSender(explicit?: string): string | undefined {
  const from = explicit ?? process.env.AGENTMGR_AGENT;
  return from && from.trim() ? from.trim() : undefined;
}

// A send is a "self send" — no attribution — only when an unqualified sender
// equals the local target. A host-qualified sender is always a peer.
export function isSelfSend(from: string, target: string): boolean {
  return !from.includes(":") && from === target;
}

// Canonical address parser. The fleet separator is ":" (host:name). We also
// tolerate the legacy "name@host" form the outbox relay used to stamp, so a
// reply pasting it still de-qualifies to the right bare name instead of
// misrouting. This is THE one parser — splitFleetKey delegates to it.
export function splitAddr(key: string): { host?: string; name: string } {
  const colon = key.indexOf(":");
  if (colon !== -1) return { host: key.slice(0, colon), name: key.slice(colon + 1) };
  const at = key.indexOf("@");
  if (at !== -1) return { name: key.slice(0, at), host: key.slice(at + 1) };
  return { name: key };
}

export function bareName(key: string): string {
  return splitAddr(key).name;
}

// The prefix recipients (LLMs) see. Terse on purpose; the primer teaches what
// it means and how to reply. Host-qualified senders keep their qualifier so the
// reply can be addressed across machines.
export function formatEnvelope(from: string, body: string): string {
  return `[am · from ${from}] ${body}`;
}

// Parse JSONL skipping torn/garbage lines, so one bad write can't brick the
// whole read path (rate limiter, backstop, `am comms`, outbox).
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a torn line rather than throwing out every entry
    }
  }
  return out;
}

function readLog(): CommsEntry[] {
  const file = commsLogFile();
  if (!existsSync(file)) return [];
  return parseJsonl<CommsEntry>(readFileSync(file, "utf8"));
}

// The ledger is read in full on every send (rate-limit window) and Stop hook, so
// bound its growth: when it gets large, keep only the most recent lines.
const LEDGER_MAX_LINES = 4000;
const LEDGER_TRIM_BYTES = 1_000_000;

function trimLedgerIfLarge(): void {
  const file = commsLogFile();
  try {
    if (statSync(file).size < LEDGER_TRIM_BYTES) return;
  } catch {
    return;
  }
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= LEDGER_MAX_LINES) return;
  const tmp = file + ".tmp";
  writeFileSync(tmp, lines.slice(-LEDGER_MAX_LINES).join("\n") + "\n");
  renameSync(tmp, file);
}

export function recordComms(entry: CommsEntry): void {
  ensureDirs();
  appendFileSync(commsLogFile(), JSON.stringify(entry) + "\n");
  trimLedgerIfLarge();
}

// How many messages this sender has sent this target within the window.
export function sendsInWindow(from: string, to: string, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return readLog().filter(
    (e) => e.from === from && e.to === to && Date.parse(e.at) >= cutoff,
  ).length;
}

// Has `from` messaged `to` at or after `since`? Used by the report backstop to
// skip the auto heads-up when the agent already reported itself this stint.
export function hasMessagedSince(from: string, to: string, since: string): boolean {
  const sinceMs = Date.parse(since);
  return readLog().some(
    (e) => e.from === from && e.to === to && Date.parse(e.at) >= sinceMs,
  );
}

// Was a message with this id already delivered? Powers receiver-side dedup so a
// redelivered claim (at-least-once) doesn't double-inject. The ledger is the
// dedup index — every attributed delivery records its msgId.
export function seenRecently(msgId: string): boolean {
  if (!msgId) return false;
  return readLog().some((e) => e.msgId === msgId);
}

export interface Attribution {
  // The body to actually deliver — wrapped in the envelope, or unchanged for a
  // self/anonymous send.
  body: string;
  // False → over the rate limit; the caller must drop the message.
  allowed: boolean;
  // True when the message was attributed (and logged to the ledger).
  attributed: boolean;
}

// Decide how a message is delivered: attribute + rate-limit when it comes from
// a peer, pass through untouched otherwise. Records the ledger entry on the way
// through so the rate limiter and `am comms` stay in sync.
export function attribute(
  from: string | undefined,
  target: string,
  body: string,
  kind: CommsKind,
  msgId?: string,
): Attribution {
  if (!from || isSelfSend(from, target)) {
    return { body, allowed: true, attributed: false };
  }
  const cfg = loadConfig();
  const windowMs = cfg.commsWindowSeconds * 1000;
  if (sendsInWindow(from, target, windowMs) >= cfg.commsMaxPerWindow) {
    return { body, allowed: false, attributed: true };
  }
  recordComms({ at: new Date().toISOString(), from, to: target, kind, body, msgId });
  return { body: formatEnvelope(from, body), allowed: true, attributed: true };
}

// Backstop gate: fire the Stop-hook heads-up only for a real work stint where
// the agent didn't already report itself. Pure — IO (the ledger lookup that
// sets alreadyReported) stays in the caller.
export function shouldReport(opts: {
  reportTo?: string;
  workedSeconds: number;
  minSeconds: number;
  alreadyReported: boolean;
}): boolean {
  return (
    !!opts.reportTo && opts.workedSeconds >= opts.minSeconds && !opts.alreadyReported
  );
}

// Recent ledger entries touching `name` in either direction, newest last.
export function commsFor(name: string, limit = 20): CommsEntry[] {
  const base = bareName(name);
  const entries = readLog().filter((e) => bareName(e.from) === base || bareName(e.to) === base);
  return entries.slice(-limit);
}
