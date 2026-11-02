import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonOrNull } from "./fsutil";
import { lifecycleLockHeld } from "./lifecycle";
import { markTurnEnded, promptKey, settleMessages } from "./messages";
import { baseDir } from "./paths";
import { ANTIGRAVITY_MAX_MESSAGE_BYTES } from "./providerLimits";
import { queueDepth } from "./queue";
import { listAgents, readAgent, updateAgentIf, updateAgentStatus, writeAgent, type AgentState } from "./state";
import { capturePane, hasSession, stripFaint, stripSgr, tmux } from "./tmux";

export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-4-argon-high";
export const ANTIGRAVITY_MAX_LINE_BYTES = 256 * 1024;
export { ANTIGRAVITY_MAX_MESSAGE_BYTES } from "./providerLimits";

export interface AntigravityOptions {
  model?: string;
  effort?: string;
  message?: string;
  resume?: string | boolean;
  continue?: boolean;
  remote?: boolean;
  skipPermissions?: boolean;
  reportTo?: string;
  role?: string;
  roleInstructions?: string;
  dir?: string;
}

export function antigravityName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error("invalid Antigravity agent name");
  return name;
}

export function antigravityOptions(opts: AntigravityOptions): AntigravityOptions & { model: string; skipPermissions: boolean } {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) throw new Error("invalid Antigravity launch options");
  if (opts.skipPermissions !== undefined && typeof opts.skipPermissions !== "boolean") throw new Error("invalid Antigravity skipPermissions: expected a boolean");
  if (opts.resume && opts.continue) throw new Error("--resume and --continue are mutually exclusive");
  if (opts.resume === true) throw new Error("Antigravity requires an exact --resume session id; no interactive picker is supported");
  if (opts.remote === true) throw new Error("Antigravity remote control is unsupported by this runner");
  for (const key of ["model", "effort", "message", "reportTo", "role", "roleInstructions", "dir"] as const) {
    if (opts[key] !== undefined && typeof opts[key] !== "string") throw new Error(`invalid Antigravity ${key}`);
  }
  const defaultModel = opts.effort && ["low", "medium", "high"].includes(opts.effort)
    ? `gemini-4-argon-${opts.effort}`
    : ANTIGRAVITY_DEFAULT_MODEL;
  const model = opts.model ?? defaultModel;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error("Antigravity requires an explicit non-empty model pin");
  if (opts.effort !== undefined && !["low", "medium", "high"].includes(opts.effort)) throw new Error("Antigravity effort must be low, medium or high");
  if (typeof opts.resume === "string" && (!opts.resume.trim() || opts.resume.length > 256 || /[\s\x00-\x1f]/.test(opts.resume) || opts.resume.startsWith("-"))) throw new Error("invalid Antigravity conversation id");
  if (opts.resume !== undefined && opts.resume !== false && typeof opts.resume !== "string") throw new Error("invalid Antigravity resume option");
  if (opts.message && Buffer.byteLength(opts.message) > ANTIGRAVITY_MAX_MESSAGE_BYTES) throw new Error("Antigravity message exceeds 64 KiB");
  const { dir: _dir, ...rest } = opts;
  return { ...rest, model, skipPermissions: opts.skipPermissions ?? false };
}

export interface AntigravityLaunchPlan {
  command: string[];
  deferredMessage?: string;
  antigravityRunId: string;
}

export function antigravityCommand(name: string, opts: AntigravityOptions): AntigravityLaunchPlan {
  antigravityName(name);
  const antigravityRunId=randomBytes(16).toString("hex");
  return { antigravityRunId, command: [process.execPath, fileURLToPath(new URL("./antigravityRunner.ts", import.meta.url)), name, JSON.stringify(antigravityOptions(opts)), JSON.stringify({runId:antigravityRunId})] };
}

function trustedWorkspacesForDir(dir: string): string[] {
  const dirs = [dir];
  try {
    const resolved = realpathSync(dir);
    if (resolved !== dir) dirs.push(resolved);
  } catch {
    // Directory may not exist yet in unit tests that only inspect the command.
  }
  return dirs;
}

// Native interactive `agy` TUI launch command for tmux. Pre-trusts the agent's
// workspace via `--settings` so worktree launches never block on the folder
// trust prompt, and submits any initial prompt interactively with `-i`.
export function antigravityTuiCommand(
  name: string,
  opts: AntigravityOptions & { initialPrompt?: string },
): { command: string[] } {
  antigravityName(name);
  const normalized = antigravityOptions(opts);
  const tierMatch = normalized.model.match(/-(low|medium|high|xhigh|max)$/);
  const includeEffort = !!normalized.effort && (!tierMatch || tierMatch[1] === normalized.effort);
  const command = [
    "agy",
    ...(normalized.skipPermissions ? ["--dangerously-skip-permissions"] : []),
    ...(opts.dir ? ["--settings", JSON.stringify({ trustedWorkspaces: trustedWorkspacesForDir(opts.dir) })] : []),
    "--model", normalized.model,
    ...(includeEffort ? ["--effort", normalized.effort!] : []),
    ...(typeof normalized.resume === "string"
      ? ["--conversation", normalized.resume]
      : normalized.continue
        ? ["--continue"]
        : []),
    ...(opts.initialPrompt ? ["-i", opts.initialPrompt] : []),
  ];
  return { command };
}

// Reservation is persisted before tmux is allowed to start. The runner receives
// its expected incarnation/generation separately from user launch options.
export function reserveAntigravityLaunch(agent: AgentState, plan: {command:string[];antigravityRunId?:string}, initial=false): AgentState {
  if(!lifecycleLockHeld(agent.name))throw new Error("Antigravity launch reservation requires the lifecycle lock");
  const runId=plan.antigravityRunId;
  if(!runId || !/^[a-f0-9]{32}$/.test(runId) || agent.provider!=="antigravity")throw new Error("invalid Antigravity launch reservation");
  plan.command[4]=JSON.stringify({runId,createdAt:agent.createdAt});
  if(initial) {
    if(readAgent(agent.name))throw new Error("Antigravity agent already exists; refusing to replace its launch identity");
    agent.antigravityRunId=runId;agent.antigravityRunPhase="pending";delete agent.antigravityCleanupRunId;
    writeAgent(agent);
  } else {
    const reserved=updateAgentIf(agent.name,current=>{
      if(current.provider!=="antigravity" || current.createdAt!==agent.createdAt || current.antigravityRunId!==agent.antigravityRunId || !current.antigravityRunId || current.antigravityCleanupRunId!==current.antigravityRunId || current.antigravityRunPhase==="pending" || runId===current.antigravityRunId)return false;
      current.antigravityRunId=runId;current.antigravityRunPhase="pending";delete current.antigravityCleanupRunId;
      updateAgentStatus(current,"starting","Antigravity launch reserved; awaiting exact runner claim");return true;
    });
    if(!reserved)throw new Error("Antigravity previous-run cleanup unverified or incarnation changed; refusing a replacement launch. Preserve the old identity and inspect its workload");
  }
  return readAgent(agent.name)!;
}

// A launch error may occur after tmux already started the runner. Never restore
// a previous generation or delete state until this generation is proven clean.
export function failAntigravityLaunch(agent:AgentState):void {
  try {stopAntigravity(agent);}
  catch {
    updateAgentIf(agent.name,current=>{
      if(current.provider!=="antigravity" || current.createdAt!==agent.createdAt || current.antigravityRunId!==agent.antigravityRunId)return false;
      updateAgentStatus(current,"needs-attention","Antigravity launch failed and exact-generation cleanup is unverified; identity and queued work preserved. Inspect the runner workload before retrying");return true;
    });
    throw new Error("Antigravity launch failed; exact-generation cleanup unverified. Identity and queued work preserved; inspect the workload before retrying");
  }
}

export function antigravityDir(name: string, createdAt = readAgent(name)?.createdAt): string {
  if (!createdAt) throw new Error("Antigravity storage requires an immutable agent incarnation");
  return join(baseDir(), "antigravity", antigravityName(name), createHash("sha256").update(createdAt).digest("hex"));
}

export function antigravityAppDataDir(): string {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) return process.env.ANTIGRAVITY_APP_DATA_DIR;
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(process.env.HOME || homedir(), ".gemini");
  return join(geminiDir, "antigravity-cli");
}

export function nativeAntigravityTranscriptPath(sessionId = ""): string {
  if (!sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(sessionId)) {
    throw new Error("Antigravity transcript requires a validated conversation identity");
  }
  return join(antigravityAppDataDir(), "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

export function antigravityTranscriptPath(name: string, createdAt = readAgent(name)?.createdAt, sessionId = readAgent(name)?.sessionId): string {
  if (!sessionId) throw new Error("Antigravity transcript requires a validated conversation identity");
  return join(antigravityDir(name, createdAt), "conversations", createHash("sha256").update(sessionId).digest("hex"), "transcript.jsonl");
}

interface AntigravityConversationSummary {
  conversationId: string;
  status: string;
  notFullyIdle: boolean;
  stepCount: number;
  lastModifiedTime: string;
}

function ownedSessionIds(excludeName: string): Set<string> {
  const owned = new Set<string>();
  for (const other of listAgents()) {
    if (other.name !== excludeName && other.sessionId) owned.add(other.sessionId);
  }
  return owned;
}

function workspaceFileUris(dir: string): Set<string> {
  const uris = new Set<string>();
  try {
    uris.add(pathToFileURL(dir).href);
  } catch {}
  try {
    uris.add(pathToFileURL(realpathSync(dir)).href);
  } catch {}
  return uris;
}

function queryAntigravitySummary(agent: AgentState): AntigravityConversationSummary | null {
  const appData = antigravityAppDataDir();
  const dbPath = join(appData, "conversation_summaries.db");
  const minTimeMs = (Date.parse(agent.createdAt) || 0) - 5_000;
  const owned = ownedSessionIds(agent.name);
  if (existsSync(dbPath)) {
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      if (agent.sessionId) {
        const row = db
          .query("SELECT conversation_id, status, not_fully_idle, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id = ?")
          .get(agent.sessionId) as {
            conversation_id: string;
            status: string;
            not_fully_idle: number;
            step_count: number;
            last_modified_time: string;
          } | null;
        if (row) {
          return {
            conversationId: row.conversation_id,
            status: row.status ?? "",
            notFullyIdle: row.not_fully_idle === 1,
            stepCount: Number(row.step_count) || 0,
            lastModifiedTime: row.last_modified_time ?? "",
          };
        }
      } else {
        const uris = workspaceFileUris(agent.dir);
        const rows = db
          .query(
            "SELECT conversation_id, status, not_fully_idle, step_count, last_modified_time, workspace_uris, parent_conversation_id FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 50",
          )
          .all() as Array<{
            conversation_id: string;
            status: string;
            not_fully_idle: number;
            step_count: number;
            last_modified_time: string;
            workspace_uris: string;
            parent_conversation_id: string | null;
          }>;
        for (const row of rows) {
          if (row.parent_conversation_id) continue;
          if (!row.conversation_id || owned.has(row.conversation_id)) continue;
          const modifiedMs = Date.parse(row.last_modified_time ?? "") || 0;
          if (minTimeMs > 0 && modifiedMs < minTimeMs) continue;
          let rowUris: unknown;
          try {
            rowUris = JSON.parse(row.workspace_uris || "[]");
          } catch {
            rowUris = [];
          }
          if (!Array.isArray(rowUris) || !rowUris.some((u) => typeof u === "string" && uris.has(u))) continue;
          return {
            conversationId: row.conversation_id,
            status: row.status ?? "",
            notFullyIdle: row.not_fully_idle === 1,
            stepCount: Number(row.step_count) || 0,
            lastModifiedTime: row.last_modified_time ?? "",
          };
        }
      }
    } catch {
      // SQLite store may not be initialized yet or could be mid-migration.
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  if (!agent.sessionId) {
    const cache = readJsonOrNull<Record<string, unknown>>(join(appData, "cache", "last_conversations.json"));
    let candidate = typeof cache?.[agent.dir] === "string" ? (cache[agent.dir] as string) : undefined;
    if (!candidate) {
      try {
        const real = realpathSync(agent.dir);
        if (typeof cache?.[real] === "string") candidate = cache[real] as string;
      } catch {}
    }
    if (candidate && !owned.has(candidate) && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(candidate)) {
      const transcript = nativeAntigravityTranscriptPath(candidate);
      try {
        const stat = statSync(transcript);
        if (minTimeMs <= 0 || stat.mtimeMs >= minTimeMs) {
          return {
            conversationId: candidate,
            status: "",
            notFullyIdle: false,
            stepCount: 0,
            lastModifiedTime: new Date(stat.mtimeMs).toISOString(),
          };
        }
      } catch {}
    }
  }
  return null;
}

function paneInputState(pane: string[]): { ready: boolean; running: boolean } {
  const plain = pane.map(stripSgr);
  const typed = pane.map((line) => stripSgr(stripFaint(line)));
  const seps: number[] = [];
  for (let i = 0; i < plain.length; i++) if (/─{8,}/.test(plain[i]!)) seps.push(i);
  if (seps.length < 2) return { ready: false, running: false };
  const top = seps[seps.length - 2]!;
  const bottom = seps[seps.length - 1]!;
  const boxPlain = plain.slice(top + 1, bottom);
  const hasComposer = boxPlain.length > 0 && /^\s*>/.test(boxPlain[0]!);
  const around = plain.slice(Math.max(0, top - 3), top).concat(plain.slice(bottom + 1));
  const running = around.some(
    (line) =>
      /esc to (?:interrupt|cancel)/i.test(line) ||
      /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s+(?:Generating|Thinking|Running|Canceling)\b/i.test(line),
  );
  // Keep `typed` referenced so compiler checks match deliver.ts semantics.
  void typed;
  return { ready: hasComposer && !running, running };
}

function transcriptCompletedSince(transcriptPath: string, sinceMs: number): boolean {
  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    let lastUserIndex = -1;
    let lastAssistantAfterUser: { createdAtMs: number; hasToolCalls: boolean; status: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      let entry: Record<string, any>;
      try {
        entry = JSON.parse(lines[i]!);
      } catch {
        return false; // Incomplete trailing write
      }
      if (entry.type === "USER_INPUT" || entry.kind === "user") {
        lastUserIndex = i;
        lastAssistantAfterUser = null;
      } else if ((entry.type === "PLANNER_RESPONSE" || entry.kind === "assistant" || entry.kind === "assistant_final") && i > lastUserIndex) {
        const ts = Date.parse(entry.created_at ?? entry.timestamp ?? "") || Date.now();
        const hasTools = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
        lastAssistantAfterUser = { createdAtMs: ts, hasToolCalls: hasTools, status: String(entry.status ?? "DONE") };
      } else if (entry.type === "GENERIC" && lastAssistantAfterUser) {
        // Still waiting for planner follow-up after tool output
        lastAssistantAfterUser = null;
      }
    }
    if (!lastAssistantAfterUser) return false;
    if (lastAssistantAfterUser.hasToolCalls || lastAssistantAfterUser.status !== "DONE") return false;
    return sinceMs <= 0 || lastAssistantAfterUser.createdAtMs >= sinceMs - 250;
  } catch {
    return false;
  }
}

const reconcileCache = new Map<string, number>();
const RECONCILE_THROTTLE_MS = 400;

// Reconcile a native interactive `agy` TUI agent's conversation ID, transcript
// path, and working/idle status from its live tmux pane and Antigravity's
// native SQLite/transcript store. No-op for legacy runner agents.
export function reconcileAntigravityAgent(
  agent: AgentState,
  opts: { pane?: string[] | null; force?: boolean } = {},
): AgentState {
  if (agent.provider !== "antigravity" || agent.antigravityRunId || agent.status === "exited") return agent;
  const nowMs = Date.now();
  const lastAt = reconcileCache.get(agent.name) ?? 0;
  if (!opts.force && nowMs - lastAt < RECONCILE_THROTTLE_MS) return readAgent(agent.name) ?? agent;
  reconcileCache.set(agent.name, nowMs);

  if (!hasSession(agent.tmuxSession)) return agent;

  const summary = queryAntigravitySummary(agent);
  const discoveredSessionId = agent.sessionId ?? summary?.conversationId;
  let nativeTranscript: string | undefined;
  if (discoveredSessionId) {
    try {
      const candidate = nativeAntigravityTranscriptPath(discoveredSessionId);
      if (existsSync(candidate)) nativeTranscript = candidate;
    } catch {}
  }

  const pane = opts.pane !== undefined ? opts.pane : capturePane(agent.tmuxSession, { colors: true });
  const paneState = pane ? paneInputState(pane) : { ready: false, running: false };
  const dbRunning =
    !!summary &&
    (summary.status === "CASCADE_RUN_STATUS_RUNNING" ||
      summary.status === "CASCADE_RUN_STATUS_BUSY" ||
      summary.status === "CASCADE_RUN_STATUS_CANCELING" ||
      summary.notFullyIdle);
  const dbIdle = !!summary && summary.status === "CASCADE_RUN_STATUS_IDLE" && !summary.notFullyIdle;
  const running = paneState.running || dbRunning;

  let transitionedToIdle = false;
  let beforeIdleSnapshot: AgentState | undefined;

  const updated = updateAgentIf(agent.name, (current) => {
    if (current.provider !== "antigravity" || current.antigravityRunId || current.createdAt !== agent.createdAt) {
      return false;
    }
    let changed = false;
    if (!current.sessionId && discoveredSessionId) {
      current.sessionId = discoveredSessionId;
      changed = true;
    }
    if (nativeTranscript && current.transcriptPath !== nativeTranscript) {
      current.transcriptPath = nativeTranscript;
      changed = true;
    }

    if (running) {
      if (current.status !== "working") {
        const iso = new Date().toISOString();
        current.workingSince ??= iso;
        current.promptAt ??= iso;
        updateAgentStatus(current, "working", "turn in progress");
        changed = true;
      }
      return changed;
    }

    const turnStartMs = Math.max(
      Date.parse(current.promptAt ?? "") || 0,
      Date.parse(current.lastHandoffAt ?? "") || 0,
      Date.parse(current.workingSince ?? "") || 0,
      Date.parse(current.statusChangedAt ?? "") || 0,
    );
    const hasCompletedTurn =
      (nativeTranscript ? transcriptCompletedSince(nativeTranscript, turnStartMs) : false) ||
      (dbIdle && (Date.parse(summary?.lastModifiedTime ?? "") || 0) >= turnStartMs && summary!.stepCount > 0);

    if (current.status === "starting") {
      const expectsInitialPrompt = Boolean(current.task || current.lastHandoffAt);
      const ageMs = nowMs - (Date.parse(current.statusChangedAt ?? current.createdAt) || 0);
      if (paneState.ready && (!expectsInitialPrompt || hasCompletedTurn || ageMs >= 2_500)) {
        beforeIdleSnapshot = { ...current };
        delete current.workingSince;
        updateAgentStatus(current, "idle", "ready at prompt");
        transitionedToIdle = true;
        changed = true;
      }
    } else if (current.status === "working") {
      const ageMs = nowMs - turnStartMs;
      if (paneState.ready && (hasCompletedTurn || ageMs >= 1_500)) {
        beforeIdleSnapshot = { ...current };
        delete current.workingSince;
        updateAgentStatus(current, "idle", "turn ended");
        transitionedToIdle = true;
        changed = true;
      }
    }
    return changed;
  });

  const result = updated ?? readAgent(agent.name) ?? agent;
  if (transitionedToIdle && beforeIdleSnapshot) {
    try {
      const endedAt = new Date(Date.parse(result.statusChangedAt ?? "") || Date.now());
      markTurnEnded(agent.name, beforeIdleSnapshot, endedAt, false, true);
      settleMessages(agent.name);
    } catch {
      // Message receipt updates must not break status reconciliation.
    }
    if (queueDepth(agent.name) > 0) {
      try {
        const { spawnDeliver } = require("./deliver") as typeof import("./deliver");
        spawnDeliver(agent.name);
      } catch {}
    }
  }
  return result;
}

export function antigravitySocketPath(runId: string): string {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error("invalid Antigravity run identity");
  return join(baseDir(), "antigravity", `r-${runId}.sock`);
}

export function antigravityDeliveryPath(name: string, id: string, createdAt = readAgent(name)?.createdAt): string {
  return join(antigravityDir(name, createdAt), "deliveries", createHash("sha256").update(id).digest("hex") + ".json");
}

export type AntigravityOutcome = "delivered" | "pending" | "unknown" | "unavailable" | "interrupted" | "stopped";
export interface AntigravityResponse {
  ok: boolean;
  outcome: AntigravityOutcome;
  reason?: string;
}
export interface AntigravityDelivery { id: string; message: string }

export function antigravityTimeout(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 100 ? Math.min(value, fallback) : fallback;
}

// A connection failure has no effect. After writing a request, loss of the
// answer is ambiguous: callers must preserve the entry and never blindly retry.
export async function antigravityRequest(agent: AgentState, action: "deliver" | "interrupt" | "stop", payload?: AntigravityDelivery): Promise<AntigravityResponse> {
  const unavailable = (reason: string): AntigravityResponse => ({ ok: false, outcome: "unavailable", reason });
  try {
    antigravityName(agent.name);
    if ((agent.provider as string) !== "antigravity" || !agent.antigravityRunId) return unavailable("Antigravity runner unavailable; start or resume the agent");
    const current = readAgent(agent.name);
    if (!current || current.createdAt !== agent.createdAt || current.antigravityRunId !== agent.antigravityRunId || current.provider !== agent.provider || (current.status === "exited" && action !== "stop")) return unavailable("Antigravity runner incarnation changed or exited; refresh the agent state");
    if (action !== "deliver" && action !== "interrupt" && action !== "stop") return unavailable("unsupported Antigravity action");
    if (action === "deliver" && (!payload || !/^[a-zA-Z0-9_-]+(?:\.json)?$/.test(payload.id) || payload.id.length > 200 || typeof payload.message !== "string" || !payload.message.trim() || Buffer.byteLength(payload.message) > ANTIGRAVITY_MAX_MESSAGE_BYTES)) return unavailable("invalid Antigravity delivery payload");
    const path = antigravitySocketPath(agent.antigravityRunId);
    return await new Promise<AntigravityResponse>((resolve) => {
      let sent = false;
      let done = false;
      let buffered = "";
      const socket = connect(path);
      const finish = (response: AntigravityResponse) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      };
      const failed = () => finish(sent ? { ok: false, outcome: "unknown", reason: "Antigravity request outcome unknown; preserve the queued entry and inspect delivery evidence before resubmitting" } : unavailable("Antigravity runner unavailable; start or resume the agent"));
      const timer = setTimeout(failed, antigravityTimeout("ANTIGRAVITY_REQUEST_TIMEOUT_MS", 12_000));
      socket.on("connect", () => {
        sent = true;
        socket.write(JSON.stringify({ action, payload, runId: agent.antigravityRunId, createdAt: agent.createdAt }) + "\n");
      });
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        if (Buffer.byteLength(buffered) > 8192) { failed(); return; }
        const nl = buffered.indexOf("\n");
        if (nl < 0) return;
        try {
          const reply = JSON.parse(buffered.slice(0, nl));
          if (typeof reply.ok !== "boolean" || !["delivered", "pending", "unknown", "unavailable", "interrupted", "stopped"].includes(reply.outcome) || (reply.reason !== undefined && typeof reply.reason !== "string")) { failed(); return; }
          finish(reply);
        } catch { failed(); }
      });
      socket.on("error", failed);
      socket.on("close", () => { if (!done) failed(); });
    });
  } catch { return unavailable("Antigravity runner unavailable; verify the local agent state and resume it"); }
}


// Synchronous lifecycle callers use a separate short-lived control process so
// the runner's async socket loop can finish owned-group cleanup before tmux is
// killed or its state is replaced. Only the runner knows its in-memory PGID.
export function stopAntigravity(agent: AgentState): void {
  if (agent.provider !== "antigravity") return;
  let current = readAgent(agent.name);
  if (!current || current.provider!=="antigravity" || current.createdAt !== agent.createdAt || current.antigravityRunId !== agent.antigravityRunId) throw new Error("Antigravity incarnation changed; refresh state before stopping");
  if (!current.antigravityRunId) {
    if (!hasSession(current.tmuxSession)) return;
    const panes = tmux("list-panes", "-t", `=${current.tmuxSession}:`, "-F", "#{pane_pid}");
    const pid = panes.exitCode === 0 ? Number.parseInt(panes.stdout.trim().split(/\s+/)[0] ?? "", 10) : NaN;
    if (Number.isInteger(pid) && pid > 1) {
      const alive = () => {
        try { process.kill(-pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException)?.code === "EPERM") return true; }
        try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
      };
      try { process.kill(-pid, "SIGTERM"); } catch {}
      try { process.kill(pid, "SIGTERM"); } catch {}
      const termDeadline = Date.now() + 200;
      while (Date.now() < termDeadline && alive()) Bun.sleepSync(10);
      if (alive()) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
        const killDeadline = Date.now() + 200;
        while (Date.now() < killDeadline && alive()) Bun.sleepSync(10);
      }
    }
    return;
  }
  if(current.antigravityRunPhase==="pending") {
    // This CAS races the runner's claim under the same state lock. Winning
    // proves that no child can ever be spawned for the cancelled generation.
    const cancelled=updateAgentIf(current.name,state=>{
      if(state.provider!=="antigravity" || state.createdAt!==current!.createdAt || state.antigravityRunId!==current!.antigravityRunId || state.antigravityRunPhase!=="pending")return false;
      state.antigravityRunPhase="cancelled";state.antigravityCleanupRunId=state.antigravityRunId;
      updateAgentStatus(state,"exited","Antigravity pending startup cancelled before runner claim; no provider workload launched");return true;
    });
    if(cancelled)return;
    current=readAgent(agent.name);
    if(!current || current.provider!=="antigravity" || current.createdAt!==agent.createdAt || current.antigravityRunId!==agent.antigravityRunId)throw new Error("Antigravity generation changed while stopping; refresh state");
  }
  if (current.antigravityCleanupRunId === current.antigravityRunId) return;
  const result = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), "stop", JSON.stringify({name:current.name,createdAt:current.createdAt,runId:current.antigravityRunId})], {
    env:{...process.env}, stdin:"ignore", stdout:"pipe", stderr:"pipe", timeout:7_000,
  });
  const after = readAgent(agent.name);
  if (result.exitCode !== 0 || !after || after.createdAt !== current.createdAt || after.antigravityRunId !== current.antigravityRunId || after.antigravityCleanupRunId !== current.antigravityRunId) throw new Error("Antigravity owned process-group cleanup unverified; stop refused. Keep state and inspect the runner before retrying");
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "stop") throw new Error("unsupported control action");
    const request = JSON.parse(process.argv[3] ?? "{}");
    const agent = readAgent(antigravityName(request.name));
    if (!agent || agent.createdAt !== request.createdAt || agent.antigravityRunId !== request.runId) throw new Error("incarnation changed");
    const reply = await antigravityRequest(agent, "stop");
    if (reply.outcome !== "stopped") throw new Error("cleanup unverified");
  } catch { process.exitCode=1; }
}
