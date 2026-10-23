import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { baseDir } from "./paths";
import { readJsonOrNull, readFileTail, writeJsonAtomic } from "./fsutil";
import { withFileLock } from "./filelock";
import { newMsgId } from "./msgid";
import type { Provider } from "./state";

// Permission and approval prompts an agent's provider is holding open, so an
// `am serve` client can answer them. Each provider's own mechanism produces
// and consumes them: Claude's PermissionRequest hook (which waits here for an
// answer, then falls back to the pane), and Codex's app-server approval
// requests, which the daemon observes on its own connection. am only ever
// relays the provider's own options and never answers on its own.

export type PermissionOptionKind = "allow" | "deny" | "allow_always";

export interface PermissionOption {
  id: string;
  label: string;
  kind: PermissionOptionKind;
}

// pending → answered (an API client chose) → applied (the provider got it).
// pending → stale (answered in the pane, the turn ended, the waiter went
// away) or expired (nobody answered in time; the pane prompt carries on).
// answered → stale when the decision couldn't reach the provider.
export type PermissionState = "pending" | "answered" | "applied" | "stale" | "expired";

export interface PermissionRecord {
  id: string;
  agent: string;
  provider: Provider;
  tool: string;
  summary: string;
  input: unknown;
  options: PermissionOption[];
  createdAt: string;
  // Null when the provider holds the request open with no deadline (Codex).
  expiresAt: string | null;
  state: PermissionState;
  optionId?: string;
  answeredAt?: string;
  resolvedAt?: string;
  resolution?: string;
  // Below: private to am, never sent to clients.
  // The provider-native decision each option sends back.
  decisions: Record<string, unknown>;
  // The process holding the request open: the hook, or the daemon.
  pid: number;
  // agentId: the subagent the call runs in (absent for the main agent).
  claude?: { toolInput: unknown; transcriptPath?: string; agentId?: string; toolUseId?: string };
  // connection: which of the daemon's app-server connections received the
  // request; its requestId means nothing on any other.
  codex?: { threadId: string; requestId: string | number; method: string; turnId?: string; connection?: number };
}

export type PublicPermission = Pick<
  PermissionRecord,
  "id" | "provider" | "tool" | "summary" | "input" | "options" | "createdAt" | "expiresAt"
>;

export type AnswerConflict = "expired" | "already_resolved" | "not_pending";

export type AnswerResult = { ok: true; id: string; optionId: string } | { ok: false; error: string; reason: AnswerConflict };

export class PermissionOptionError extends Error {}

// Same shape as message ids (msgid.ts); anything else never reaches a path.
export const PERMISSION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// How long a terminal record is kept, so a late answer gets a 409 that says
// why rather than a 404.
const KEEP_RESOLVED_MS = 24 * 60 * 60 * 1000;

export function isPermissionId(id: string): boolean {
  return PERMISSION_ID_RE.test(id);
}

export function permissionsDir(): string {
  return join(baseDir(), "permissions");
}

function recordFile(id: string): string {
  return join(permissionsDir(), `${id}.json`);
}

// Records carry tool input (commands, file contents): owner-only.
const RECORD_MODE = 0o600;

function withLock<T>(fn: () => T): T {
  mkdirSync(permissionsDir(), { recursive: true, mode: 0o700 });
  return withFileLock(join(permissionsDir(), ".lock"), fn);
}

export function readPermission(id: string): PermissionRecord | null {
  if (!isPermissionId(id)) return null;
  return readJsonOrNull<PermissionRecord>(recordFile(id));
}

export function listPermissions(): PermissionRecord[] {
  let files: string[];
  try {
    files = readdirSync(permissionsDir());
  } catch {
    return [];
  }
  const records: PermissionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const record = readJsonOrNull<PermissionRecord>(join(permissionsDir(), file));
    if (record && isPermissionId(record.id)) records.push(record);
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

function prune(now: number): void {
  for (const record of listPermissions()) {
    if (record.state === "pending" || record.state === "answered") continue;
    const at = Date.parse(record.resolvedAt ?? record.createdAt) || 0;
    if (now - at > KEEP_RESOLVED_MS) rmSync(recordFile(record.id), { force: true });
  }
}

export function createPermission(
  fields: Omit<PermissionRecord, "id" | "state" | "createdAt"> & { createdAt?: string },
): PermissionRecord {
  return withLock(() => {
    const now = Date.now();
    prune(now);
    const record: PermissionRecord = {
      ...fields,
      id: newMsgId(now),
      state: "pending",
      createdAt: fields.createdAt ?? new Date(now).toISOString(),
    };
    writeJsonAtomic(recordFile(record.id), record, { mode: RECORD_MODE });
    return record;
  });
}

// Read-modify-write under the store lock; `fn` returns false to leave it.
export function updatePermission(id: string, fn: (record: PermissionRecord) => boolean): PermissionRecord | null {
  return withLock(() => {
    const record = readPermission(id);
    if (!record) return null;
    if (!fn(record)) return record;
    writeJsonAtomic(recordFile(id), record, { mode: RECORD_MODE });
    return record;
  });
}

function settle(record: PermissionRecord, state: "stale" | "expired" | "applied", resolution: string): void {
  record.state = state;
  record.resolvedAt = new Date().toISOString();
  record.resolution = resolution;
}

// End a request that is still pending (or, with `from`, in one of those
// states). Returns whether it was.
export function resolvePending(
  id: string,
  state: "stale" | "expired",
  resolution: string,
  from: PermissionState[] = ["pending"],
): boolean {
  let changed = false;
  updatePermission(id, (record) => {
    if (!from.includes(record.state)) return false;
    settle(record, state, resolution);
    changed = true;
    return true;
  });
  return changed;
}

// The answerer took the decision: called by whoever holds the provider's
// request, under the lock, so a pane answer can't slip in between. `deliver`
// hands it to the provider inside the claim: only a delivery that didn't
// throw counts as applied; one that did ends the request stale, so the
// answerer hears it failed. Null unless it was applied.
export function claimAnswer(id: string, deliver?: (record: PermissionRecord) => void): PermissionRecord | null {
  let claimed: PermissionRecord | null = null;
  updatePermission(id, (record) => {
    if (record.state !== "answered") return false;
    try {
      deliver?.(record);
    } catch {
      settle(record, "stale", "delivering the decision to the provider failed");
      return true;
    }
    settle(record, "applied", "answered through am");
    claimed = record;
    return true;
  });
  return claimed;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Expire what ran out of time and drop what nobody holds any more, so a
// client never sees a request it can't answer. Returns the ids it ended.
export function refreshPermissions(now = Date.now(), alive = pidAlive): string[] {
  const ended: string[] = [];
  for (const record of listPermissions()) {
    if (record.state !== "pending") continue;
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
      if (resolvePending(record.id, "expired", "nobody answered in time")) ended.push(record.id);
    } else if (!alive(record.pid)) {
      if (resolvePending(record.id, "stale", "the provider stopped waiting")) ended.push(record.id);
    }
  }
  return ended;
}

export function pendingPermissions(names: string[]): PermissionRecord[] {
  refreshPermissions();
  return listPermissions().filter((r) => r.state === "pending" && names.includes(r.agent));
}

export function publicPermission(record: PermissionRecord): PublicPermission {
  const { id, provider, tool, summary, input, options, createdAt, expiresAt } = record;
  return { id, provider, tool, summary, input, options, createdAt, expiresAt };
}

// End every pending request of this agent that `match` picks (all, by default).
export function stalePermissions(
  names: string[],
  resolution: string,
  match: (record: PermissionRecord) => boolean = () => true,
): PermissionRecord[] {
  const ended: PermissionRecord[] = [];
  for (const record of listPermissions()) {
    if (record.state !== "pending" || !names.includes(record.agent) || !match(record)) continue;
    if (resolvePending(record.id, "stale", resolution)) ended.push(record);
  }
  return ended;
}

function conflictFor(record: PermissionRecord): AnswerResult & { ok: false } {
  if (record.state === "expired") return { ok: false, error: `permission request ${record.id} expired`, reason: "expired" };
  if (record.state === "answered" || record.state === "applied") {
    return { ok: false, error: `permission request ${record.id} is already resolved`, reason: "already_resolved" };
  }
  return {
    ok: false,
    error: `permission request ${record.id} is no longer pending${record.resolution ? ` (${record.resolution})` : ""}`,
    reason: "not_pending",
  };
}

// Answer a pending request with one of its provider's options, then wait for
// whoever holds the request to hand the decision to the provider. Null for an
// unknown id; PermissionOptionError for an option the request doesn't offer.
export async function answerPermission(
  names: string[],
  id: string,
  optionId: string,
  opts: { ackMs?: number; pollMs?: number; alive?: (pid: number) => boolean } = {},
): Promise<AnswerResult | null> {
  const record = readPermission(id);
  if (!record || !names.includes(record.agent)) return null;
  refreshPermissions(Date.now(), opts.alive);
  let refused: (AnswerResult & { ok: false }) | null = null;
  let badOption = false;
  updatePermission(id, (current) => {
    if (current.state !== "pending") {
      refused = conflictFor(current);
      return false;
    }
    if (!current.options.some((o) => o.id === optionId) || !(optionId in current.decisions)) {
      badOption = true;
      return false;
    }
    current.state = "answered";
    current.optionId = optionId;
    current.answeredAt = new Date().toISOString();
    return true;
  });
  if (badOption) throw new PermissionOptionError(`unknown permission option "${optionId}" for request ${id}`);
  if (refused) return refused;

  const deadline = Date.now() + (opts.ackMs ?? 5000);
  for (;;) {
    const current = readPermission(id);
    if (current?.state === "applied") return { ok: true, id, optionId };
    // Withdrawn under it (delivery failed, the connection went): say why.
    if (current && current.state !== "answered") return conflictFor(current);
    if (Date.now() >= deadline) break;
    await Bun.sleep(opts.pollMs ?? 100);
  }
  // Nobody picked it up: take it back, unless it landed meanwhile.
  let applied = false;
  updatePermission(id, (current) => {
    if (current.state === "applied") {
      applied = true;
      return false;
    }
    if (current.state !== "answered") return false;
    settle(current, "stale", "the provider did not take the decision");
    return true;
  });
  if (applied) return { ok: true, id, optionId };
  return { ok: false, error: `permission request ${id} is no longer pending (the provider did not take the decision)`, reason: "not_pending" };
}

// --- Claude Code ------------------------------------------------------------

export interface ClaudePermissionSuggestion {
  type?: string;
  rules?: { toolName?: string; ruleContent?: string }[];
  behavior?: string;
  mode?: string;
  directories?: string[];
  destination?: string;
}

const DESTINATIONS: Record<string, string> = {
  session: "for this session",
  localSettings: "(saved to .claude/settings.local.json)",
  projectSettings: "(saved to .claude/settings.json)",
  userSettings: "(saved to ~/.claude/settings.json)",
};

function describeSuggestion(s: ClaudePermissionSuggestion): string | null {
  const where = DESTINATIONS[s.destination ?? ""] ?? (s.destination ? `(${s.destination})` : "");
  const rules = (s.rules ?? []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : `${r.toolName}`)).join(", ");
  switch (s.type) {
    case "addRules":
      if (s.behavior !== "allow") return null;
      return `Yes, and always allow ${rules} ${where}`.trim();
    case "addDirectories":
      return `Yes, and allow access to ${(s.directories ?? []).join(", ")} ${where}`.trim();
    case "setMode":
      return `Yes, and switch to ${s.mode} mode ${where}`.trim();
    default:
      return null;
  }
}

// A once-only allow, one "allow + remember" per suggestion Claude made (the
// suggestion itself goes back as updatedPermissions, so Claude persists it
// exactly where it proposed to, or not at all), and a deny.
export function claudePermissionOptions(suggestions: unknown): {
  options: PermissionOption[];
  decisions: Record<string, unknown>;
} {
  const options: PermissionOption[] = [{ id: "allow", label: "Yes", kind: "allow" }];
  const decisions: Record<string, unknown> = { allow: { behavior: "allow" } };
  (Array.isArray(suggestions) ? suggestions : []).forEach((suggestion, i) => {
    if (!suggestion || typeof suggestion !== "object") return;
    const label = describeSuggestion(suggestion as ClaudePermissionSuggestion);
    if (!label) return;
    const id = `suggestion-${i}`;
    options.push({ id, label, kind: "allow_always" });
    decisions[id] = { behavior: "allow", updatedPermissions: [suggestion] };
  });
  options.push({ id: "deny", label: "No", kind: "deny" });
  decisions.deny = { behavior: "deny", message: "The operator denied this permission request through am." };
  return { options, decisions };
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function claudePermissionSummary(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  const main = str("command") ?? str("file_path") ?? str("notebook_path") ?? str("url") ?? str("pattern") ?? str("path");
  if (main) return oneLine(`${tool}: ${main}`);
  const json = JSON.stringify(input ?? {});
  return oneLine(`${tool}: ${json === "{}" ? "" : json}`.trim().replace(/:$/, ""));
}

export function claudeDecisionOutput(decision: unknown): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sameToolCall(a: { tool: string; input: unknown }, b: { tool: string; input: unknown }): boolean {
  return a.tool === b.tool && stableJson(a.input) === stableJson(b.input);
}

const TRANSCRIPT_TAIL_BYTES = 2_000_000;

// The tool_use ids in Claude's transcript for this exact call, and which of
// them already have a result. Claude writes the tool_use before it asks, and
// a tool_result once the call was allowed, denied or interrupted, however it
// was answered — so a result for a call that had none means the pane (or
// another answer) got there first.
export function claudeToolCallStates(
  transcriptPath: string,
  tool: string,
  input: unknown,
): { uses: string[]; answered: string[] } {
  const text = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES) ?? "";
  const uses: string[] = [];
  const results = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes("tool_")) continue;
    let entry: { message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === "tool_use" && typeof block.id === "string" && sameToolCall({ tool, input }, { tool: String(block.name), input: block.input })) {
        uses.push(block.id);
      } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.add(block.tool_use_id);
      }
    }
  }
  return { uses, answered: uses.filter((id) => results.has(id)) };
}
