import { createHash } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseDir } from "./paths";
import { ANTIGRAVITY_MAX_MESSAGE_BYTES } from "./providerLimits";
import { readAgent, type AgentState } from "./state";

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
  reportTo?: string;
  role?: string;
  roleInstructions?: string;
}

export function antigravityName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error("invalid Antigravity agent name");
  return name;
}

export function antigravityOptions(opts: AntigravityOptions): AntigravityOptions & { model: string } {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) throw new Error("invalid Antigravity launch options");
  if (opts.resume && opts.continue) throw new Error("--resume and --continue are mutually exclusive");
  if (opts.resume === true) throw new Error("Antigravity headless mode requires an exact --resume session id; no interactive picker is supported");
  if (opts.remote === true) throw new Error("Antigravity remote control is unsupported by this runner");
  for (const key of ["model", "effort", "message", "reportTo", "role", "roleInstructions"] as const) {
    if (opts[key] !== undefined && typeof opts[key] !== "string") throw new Error(`invalid Antigravity ${key}`);
  }
  const model = opts.model ?? ANTIGRAVITY_DEFAULT_MODEL;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error("Antigravity requires an explicit non-empty model pin");
  if (opts.effort !== undefined && !["low", "medium", "high"].includes(opts.effort)) throw new Error("Antigravity effort must be low, medium or high");
  if (typeof opts.resume === "string" && (!opts.resume.trim() || opts.resume.length > 256 || /[\s\x00-\x1f]/.test(opts.resume) || opts.resume.startsWith("-"))) throw new Error("invalid Antigravity conversation id");
  if (opts.resume !== undefined && opts.resume !== false && typeof opts.resume !== "string") throw new Error("invalid Antigravity resume option");
  if (opts.message && Buffer.byteLength(opts.message) > ANTIGRAVITY_MAX_MESSAGE_BYTES) throw new Error("Antigravity message exceeds 64 KiB");
  return { ...opts, model };
}

export function antigravityCommand(name: string, opts: AntigravityOptions): { command: string[]; deferredMessage?: string } {
  antigravityName(name);
  return { command: [process.execPath, fileURLToPath(new URL("./antigravityRunner.ts", import.meta.url)), name, JSON.stringify(antigravityOptions(opts))] };
}

export function antigravityDir(name: string, createdAt = readAgent(name)?.createdAt): string {
  if (!createdAt) throw new Error("Antigravity storage requires an immutable agent incarnation");
  return join(baseDir(), "antigravity", antigravityName(name), createHash("sha256").update(createdAt).digest("hex"));
}

export function antigravityTranscriptPath(name: string, createdAt = readAgent(name)?.createdAt, sessionId = readAgent(name)?.sessionId): string {
  if (!sessionId) throw new Error("Antigravity transcript requires a validated conversation identity");
  return join(antigravityDir(name, createdAt), "conversations", createHash("sha256").update(sessionId).digest("hex"), "transcript.jsonl");
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
  const current = readAgent(agent.name);
  if (!current || current.createdAt !== agent.createdAt || current.antigravityRunId !== agent.antigravityRunId) throw new Error("Antigravity incarnation changed; refresh state before stopping");
  if (!current.antigravityRunId) throw new Error("Antigravity cleanup cannot be verified: no runner identity; inspect the failed launch before removing or restarting");
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
