// Pure composer logic: which bubbles to show after a send, which mode a send
// uses, drafts, and the sentence for each failure. main.ts only wires the DOM.
import { MESSAGE_CONTROL, MESSAGE_EMPTY, MESSAGE_TOO_LONG, MODE_INVALID, type SendMode } from "./policy";
import type { ApiResponse, Provider, QueueItem, TranscriptEntry } from "./types";

// A message sent mid-turn is held by the agent until it reads it, so it stays
// on screen until a user turn logged after the send matches it (the browser
// UI's notePending/pendingFor, kept pure here).

export const PENDING_TTL_MS = 30 * 60_000;

export interface PendingMessage {
  id?: string;
  // Whitespace-normalised, for matching.
  match: string;
  shown: string;
  at: number;
  // User turns in the transcript when it was sent; only later turns can match.
  baseline: number;
}

export const normalizeMessage = (text: string): string =>
  String(text || "").replace(/<\/?pasted_content(?: id="[^"]*")?>/g, "").replace(/\s+/g, " ").trim();

export const userTexts = (entries: readonly TranscriptEntry[]): string[] =>
  entries.filter((entry) => entry.kind === "user").map((entry) => normalizeMessage((entry as { text: string }).text));

export function notePending(list: readonly PendingMessage[], text: string, id: string | undefined, baseline: number, now: number): PendingMessage[] {
  return [...list, { ...(id ? { id } : {}), match: normalizeMessage(text), shown: text, at: now, baseline }];
}

// Drops pending messages that have shown up in the transcript or expired.
export function reconcilePending(list: readonly PendingMessage[], entries: readonly TranscriptEntry[], now: number): PendingMessage[] {
  const users = userTexts(entries);
  const claimed = new Set<number>();
  const kept: PendingMessage[] = [];
  for (const pending of list) {
    if (now - pending.at >= PENDING_TTL_MS) continue;
    // Fewer user turns than when it was sent: a new session started.
    const baseline = users.length && users.length < pending.baseline ? 0 : pending.baseline;
    const index = users.findIndex((text, i) => i >= baseline && !claimed.has(i) && (text === pending.match || text.startsWith(pending.match)));
    if (index >= 0) {
      claimed.add(index);
      continue;
    }
    kept.push(baseline === pending.baseline ? pending : { ...pending, baseline });
  }
  return kept;
}

export type BubbleState = "sent" | "queued";
export interface Bubble {
  key: string;
  text: string;
  state: BubbleState;
  // Set when the bubble can be cancelled (a queued message with an id).
  cancelId?: string;
}

function hashKey(scope: string, id: string | undefined, text: string): string {
  if (id) return `${scope}:${id}`;
  let hash = 2166136261;
  for (const character of text) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }
  return `${scope}:text-${(hash >>> 0).toString(36)}`;
}

const queueText = (item: QueueItem): string => item.text || item.message || "";

// Which queue items are our own sends: queue index -> pending message. The
// server lists an API-queued message without its record id, so match by msgId
// if present, else by text against items without one, each item at most once.
// A queue item's own msgId (an inter-agent message) is not a record id.
export function claimQueue(pending: readonly PendingMessage[], queue: readonly QueueItem[]): Map<number, PendingMessage> {
  const claimed = new Map<number, PendingMessage>();
  for (const message of pending) {
    if (!message.id) continue;
    let index = queue.findIndex((item, i) => !claimed.has(i) && item.msgId === message.id);
    if (index < 0) {
      index = queue.findIndex((item, i) => {
        if (claimed.has(i) || item.msgId) return false;
        const text = normalizeMessage(queueText(item));
        return text === message.match || text.startsWith(message.match);
      });
    }
    if (index >= 0) claimed.set(index, message);
  }
  return claimed;
}

// Pending messages not yet in the queue ("sent"), then the queue in order. A
// pending message found in the queue is shown once, as queued, and only those
// can be cancelled.
export function bubbles(pending: readonly PendingMessage[], queue: readonly QueueItem[] | undefined): Bubble[] {
  const items = Array.isArray(queue) ? queue : [];
  const claimed = claimQueue(pending, items);
  const inQueue = new Set(claimed.values());
  const result: Bubble[] = [];
  for (const message of pending) {
    if (inQueue.has(message)) continue;
    result.push({ key: hashKey("pending", message.id ?? String(message.at), message.shown), text: message.shown, state: "sent" });
  }
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const own = claimed.get(index);
    if (own) {
      result.push({ key: hashKey("pending", own.id, own.shown), text: own.shown, state: "queued", cancelId: own.id });
      return;
    }
    const text = queueText(item) || "Queued message";
    let key = hashKey("queue", item.msgId, text);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count) key += `#${count}`;
    result.push({ key, text, state: "queued" });
  });
  return result;
}

// After cancelling `id`: drop the pending message and the queue item it claimed.
export function withoutMessage(pending: readonly PendingMessage[], queue: readonly QueueItem[] | undefined, id: string): { pending: PendingMessage[]; queue: QueueItem[] } {
  const items = Array.isArray(queue) ? queue : [];
  const claimed = claimQueue(pending, items);
  return {
    pending: pending.filter((message) => message.id !== id),
    queue: items.filter((_, index) => claimed.get(index)?.id !== id),
  };
}

export const BUBBLE_LABEL: Record<BubbleState, string> = {
  sent: "Sent · waiting for the agent to read it",
  queued: "Queued · sends when the agent is free",
};

export const MODE_HINT: Record<SendMode, string> = {
  now: "Read at the agent's next input boundary",
  queue: "Delivered when the agent is free",
};
export const FORCED_QUEUE_HINT = "Antigravity can't be steered mid-turn, so messages wait until it is free";

export interface ModeChoice {
  mode: SendMode;
  // False when the provider only takes queued messages.
  choosable: boolean;
}

export function modeFor(provider: Provider | string | undefined, preference: SendMode | null): ModeChoice {
  if (provider === "antigravity") return { mode: "queue", choosable: false };
  if (preference) return { mode: preference, choosable: true };
  return { mode: provider === "claude" || provider === "codex" ? "now" : "queue", choosable: true };
}

// ⌥Enter: the other mode, once, where the provider allows it.
export const sendModeFor = (choice: ModeChoice, alternate: boolean): SendMode =>
  alternate && choice.choosable ? (choice.mode === "now" ? "queue" : "now") : choice.mode;

export const parseModePreference = (raw: string | null): SendMode | null => (raw === "now" || raw === "queue" ? raw : null);

// What stays in the box once `sent` was accepted: nothing if it is unchanged,
// the rest if the user kept typing after it, otherwise everything they have.
export function textAfterSend(current: string, sent: string): { text: string; removed: number } {
  if (current === sent) return { text: "", removed: current.length };
  if (sent && current.startsWith(sent)) {
    const rest = current.slice(sent.length);
    const trimmed = rest.replace(/^\s+/, "");
    return { text: trimmed, removed: current.length - trimmed.length };
  }
  return { text: current, removed: 0 };
}

export const DRAFT_MAX_COUNT = 50;
export const DRAFT_MAX_CHARS = 200_000;
export const DRAFTS_MAX_TOTAL_CHARS = 1_000_000;

export interface Draft {
  text: string;
  at: number;
}
export type Drafts = Record<string, Draft>;

export function parseDrafts(raw: string | null): Drafts {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const drafts: Drafts = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const draft = value as Partial<Draft> | null;
      if (draft && typeof draft.text === "string" && draft.text && typeof draft.at === "number") drafts[key] = { text: draft.text, at: draft.at };
    }
    return capDrafts(drafts);
  } catch {
    return {};
  }
}

// Keeps the newest drafts within the count and size caps, for storage. A draft
// too large to store stays in memory while the app is open.
export function capDrafts(drafts: Drafts): Drafts {
  const entries = Object.entries(drafts)
    .filter(([, draft]) => draft.text.length <= DRAFT_MAX_CHARS)
    .sort(([, a], [, b]) => b.at - a.at);
  const kept: Drafts = {};
  let total = 0, count = 0;
  for (const [key, draft] of entries) {
    if (count >= DRAFT_MAX_COUNT || total + draft.text.length > DRAFTS_MAX_TOTAL_CHARS) continue;
    kept[key] = draft;
    total += draft.text.length;
    count++;
  }
  return kept;
}

export function putDraft(drafts: Drafts, key: string, text: string, now: number): Drafts {
  const next = { ...drafts };
  if (text.trim()) next[key] = { text, at: now };
  else delete next[key];
  return next;
}

export const AMBIGUOUS_SEND = "Couldn't reach the server. The message may or may not have been sent.";
export const TOKEN_REJECTED = "The server rejected the access token. Update it from Connections in the status bar.";

export interface Outcome {
  // Shown above the composer; null when there is nothing to say.
  error: string | null;
  tokenRejected?: boolean;
  // Cancel of a message the server no longer knows: treat it as gone.
  gone?: boolean;
}

const CONFLICT: Record<string, string> = {
  no_session: "The agent has no live session",
  mailbox_busy: "The agent's mailbox is busy; try again",
  remote_too_old: "The remote host's am is too old for this",
};
const CANCEL_CONFLICT: Record<string, string> = {
  already_delivered: "Already delivered",
  already_done: "Already delivered",
  already_cancelled: "Already cancelled",
  already_failed: "Delivery already failed",
};

function bodyField(body: unknown, field: "error" | "reason"): string | undefined {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

export function sendOutcome(response: ApiResponse): Outcome {
  const { status, body } = response;
  if (status >= 200 && status < 300) return { error: null };
  if (status === 401) return { error: TOKEN_REJECTED, tokenRejected: true };
  if (status === 404) return { error: "This agent no longer exists" };
  const server = bodyField(body, "error");
  if (status === 409) {
    const reason = bodyField(body, "reason") ?? "";
    return { error: CONFLICT[reason] ?? server ?? "The server did not take the message" };
  }
  if (status === 400) return { error: server ?? "The server refused the message" };
  if (status >= 300 && status < 400) return { error: `The server redirected the request (HTTP ${status}); check the connection URL` };
  // A proxy error says nothing about whether am itself took the message.
  if (status >= 500) return { error: `The server returned HTTP ${status}${server ? `: ${server}` : ""}. The message may or may not have been sent.` };
  return { error: `The server returned HTTP ${status}${server ? `: ${server}` : ""}` };
}

export function cancelOutcome(response: ApiResponse): Outcome {
  const { status, body } = response;
  if (status >= 200 && status < 300) return { error: null };
  if (status === 401) return { error: TOKEN_REJECTED, tokenRejected: true };
  if (status === 404) return { error: null, gone: true };
  const server = bodyField(body, "error");
  if (status === 409) {
    const reason = bodyField(body, "reason") ?? "";
    return { error: CANCEL_CONFLICT[reason] ?? CONFLICT[reason] ?? server ?? "The message could not be cancelled" };
  }
  return { error: `Couldn't cancel: the server returned HTTP ${status}${server ? `: ${server}` : ""}` };
}

// A bridge rejection. Validation errors mean nothing was sent; anything else
// (network failure, timeout) leaves delivery unknown, and nothing is retried.
const DEFINITE = [MESSAGE_EMPTY, MESSAGE_TOO_LONG, MESSAGE_CONTROL, MODE_INVALID, "invalid agent:", "invalid message id:", "unknown connection:", "text must be a string"];
export function rejectionOutcome(error: unknown, action: "send" | "cancel"): Outcome {
  const message = error instanceof Error ? error.message : String(error);
  if (DEFINITE.some((prefix) => message.startsWith(prefix))) return { error: message };
  return { error: action === "send" ? AMBIGUOUS_SEND : "Couldn't reach the server to cancel the message." };
}
