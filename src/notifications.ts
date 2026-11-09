import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./filelock";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { baseDir } from "./paths";
import { newMsgId } from "./msgid";

export type NotificationKind = "attention" | "idle" | "share";

export interface NotificationEntry {
  id: string;
  at: string;
  host: string;
  agent?: string;
  kind: NotificationKind;
  title: string;
  message: string;
}

export interface NotificationBatch {
  entries: NotificationEntry[];
  // The caller's next --after.
  cursor?: string;
}

const MAX_BYTES = 256 * 1024;
const KEEP_ENTRIES = 500;
const MAX_BATCH = 100;
// Cursor for an empty journal; no id matches it, so it reads as "before everything".
export const JOURNAL_START = "start";

export function notificationsFile(): string {
  return join(baseDir(), "notifications.jsonl");
}

function lockFile(): string {
  return join(baseDir(), "notifications.lock");
}

function cursorsFile(): string {
  return join(baseDir(), "notification-cursors.json");
}

export function readNotifications(): NotificationEntry[] {
  let text: string;
  try {
    text = readFileSync(notificationsFile(), "utf8");
  } catch {
    return [];
  }
  const entries: NotificationEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as NotificationEntry;
      if (typeof entry?.id === "string" && typeof entry.message === "string") entries.push(entry);
    } catch {}
  }
  return entries;
}

export function recordNotification(entry: Omit<NotificationEntry, "id" | "at"> & { at?: string }): NotificationEntry {
  const full: NotificationEntry = { id: newMsgId(), at: entry.at ?? new Date().toISOString(), ...entry };
  withFileLock(lockFile(), () => {
    appendFileSync(notificationsFile(), JSON.stringify(full) + "\n");
    if (statSync(notificationsFile()).size > MAX_BYTES) {
      // Keep the newest entries that fit in half the budget, so trims are rare.
      const lines = readNotifications().slice(-KEEP_ENTRIES).map((e) => JSON.stringify(e) + "\n");
      let bytes = 0;
      let start = lines.length;
      while (start > 0 && bytes + Buffer.byteLength(lines[start - 1]!) <= MAX_BYTES / 2) bytes += Buffer.byteLength(lines[--start]!);
      writeFileSync(notificationsFile(), lines.slice(start).join(""));
    }
  });
  return full;
}

// No cursor means a fresh subscriber: return only the position, not history.
// A trimmed-away cursor returns the survivors (at most MAX_BATCH).
export function notificationsAfter(entries: NotificationEntry[], after: string | undefined): NotificationBatch {
  const last = entries.at(-1)?.id;
  if (!after) return { entries: [], cursor: last ?? JOURNAL_START };
  const index = entries.findIndex((e) => e.id === after);
  const fresh = index === -1 ? entries : entries.slice(index + 1);
  const batch = fresh.slice(-MAX_BATCH);
  return { entries: batch, cursor: batch.at(-1)?.id ?? after };
}

function journalSignature(): string {
  try {
    const s = statSync(notificationsFile());
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

export async function notificationsPollCommand(opts: { after?: string; waitSeconds?: number }): Promise<void> {
  const deadline = Date.now() + Math.min(Math.max(opts.waitSeconds ?? 0, 0), 60) * 1000;
  let batch = notificationsAfter(readNotifications(), opts.after);
  let signature = journalSignature();
  while (opts.after && batch.entries.length === 0 && Date.now() < deadline) {
    await Bun.sleep(500);
    const next = journalSignature();
    if (next === signature) continue;
    signature = next;
    batch = notificationsAfter(readNotifications(), opts.after);
  }
  console.log(JSON.stringify(batch));
}

export function notificationsListCommand(opts: { json?: boolean; limit?: number }): void {
  const entries = readNotifications().slice(-(opts.limit ?? 20));
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("no notifications recorded on this host");
    return;
  }
  for (const e of entries) {
    const when = new Date(e.at).toLocaleString();
    console.log(`${when}  ${e.kind.padEnd(9)} ${e.agent ?? "-"}  ${e.message}`);
  }
}

export function readRelayCursors(): Record<string, string> {
  return readJsonOrNull<Record<string, string>>(cursorsFile()) ?? {};
}

export function writeRelayCursor(host: string, cursor: string): void {
  withFileLock(lockFile(), () => {
    writeJsonAtomic(cursorsFile(), { ...readRelayCursors(), [host]: cursor });
  });
}

export interface Display {
  title: string;
  message: string;
}

// Stale or over-cap entries (the laptop slept) collapse into one summary.
export function planRelayDisplay(
  host: string,
  entries: NotificationEntry[],
  now: number,
  opts: { staleMs?: number; maxIndividual?: number } = {},
): Display[] {
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const max = opts.maxIndividual ?? 4;
  const recent = entries.filter((e) => now - Date.parse(e.at) <= staleMs);
  const shown = recent.slice(-max);
  const collapsed = entries.length - shown.length;
  const displays: Display[] = [];
  if (collapsed > 0) {
    const agents = [...new Set(entries.slice(0, entries.length - shown.length).map((e) => e.agent).filter(Boolean))];
    const who = agents.length ? `: ${agents.slice(0, 4).join(", ")}${agents.length > 4 ? ", …" : ""}` : "";
    displays.push({ title: `am (${host})`, message: `${collapsed} earlier notification${collapsed === 1 ? "" : "s"}${who}` });
  }
  for (const e of shown) displays.push({ title: `${e.title} (${host})`, message: e.message });
  return displays;
}
