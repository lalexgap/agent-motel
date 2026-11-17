// Agent Motel's bridge into Amp. am installs this file as a system plugin
// (~/.config/amp/plugins/agent-motel.ts, see src/ampPlugin.ts) and Amp runs
// it for every thread on the machine, so it does nothing unless am launched
// this Amp process as an agent (AGENTMGR_AMP_AGENT naming the same agent as
// AGENTMGR_AGENT). AGENTMGR_AGENT alone isn't enough: a Claude or Codex agent
// running `amp -x` passes it on too. For a managed agent it maps
// Amp's plugin events onto am's existing hook commands, handing each the
// Claude-shaped JSON it reads on stdin:
//   session.start  -> am hook session-start
//   agent.start    -> am hook user-prompt-submit (its context is appended to the prompt)
//   agent.end      -> am hook stop (a block becomes a `continue` turn, while
//                     Amp would still honour one)
//   tool.call      -> am hook pre-tool-use, or subagent-start for Task
//   tool.result    -> am hook post-tool-use, or subagent-stop for Task
// It also hands queued am messages to the thread while it is idle (am hook
// amp-drain), since Amp has no hook that fires for an idle agent.
//
// Self-contained on purpose: Amp loads it from outside the am checkout, so it
// imports only Node built-ins. The pure helpers are exported for am's tests.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const description = "Agent Motel bridge: reports status to am and delivers am messages. Inert outside am-managed agents.";

export type HookPayload = Record<string, unknown>;
export interface HookCall {
  sub: string;
  payload: HookPayload;
}

// The plugin acts only inside an Amp process am launched as an agent.
export function managedAgent(env: Record<string, string | undefined>): string | null {
  const name = env.AGENTMGR_AGENT;
  return name && name.trim() && env.AGENTMGR_AMP_AGENT === name ? name : null;
}

// How to run am: the exact binary am launched with, else `am` on PATH.
export function amCommand(env: Record<string, string | undefined>): string[] {
  try {
    const parsed = JSON.parse(env.AGENTMGR_AM_CMD ?? "");
    if (Array.isArray(parsed) && parsed.length && parsed.every((part) => typeof part === "string" && part)) return parsed;
  } catch {
    // fall through
  }
  return ["am"];
}

// Amp's subagent tool. Its own call is the subagent's lifetime.
export const AMP_SUBAGENT_TOOL = "Task";

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function sessionStartHook(thread: string, cwd: string): HookCall {
  return { sub: "session-start", payload: { session_id: thread, cwd, source: "startup", hook_event_name: "SessionStart" } };
}

export function agentStartHook(thread: string, cwd: string, prompt: string): HookCall {
  return { sub: "user-prompt-submit", payload: { session_id: thread, cwd, prompt, hook_event_name: "UserPromptSubmit" } };
}

export interface ToolEventLike {
  toolUseID: string;
  tool: string;
  input?: Record<string, unknown>;
  status?: string;
  error?: string;
  output?: unknown;
}

export function toolCallHook(thread: string, cwd: string, event: ToolEventLike): HookCall {
  if (event.tool === AMP_SUBAGENT_TOOL) {
    return {
      sub: "subagent-start",
      payload: { session_id: thread, cwd, agent_id: event.toolUseID, agent_type: AMP_SUBAGENT_TOOL, hook_event_name: "SubagentStart" },
    };
  }
  return {
    sub: "pre-tool-use",
    payload: { session_id: thread, cwd, tool_name: event.tool, tool_input: event.input ?? {}, tool_use_id: event.toolUseID, hook_event_name: "PreToolUse" },
  };
}

export function toolResultHook(thread: string, cwd: string, event: ToolEventLike): HookCall {
  if (event.tool === AMP_SUBAGENT_TOOL) {
    const message = text(event.output) ?? event.error;
    return {
      sub: "subagent-stop",
      payload: {
        session_id: thread,
        cwd,
        agent_id: event.toolUseID,
        agent_type: AMP_SUBAGENT_TOOL,
        ...(message ? { last_assistant_message: message } : {}),
        hook_event_name: "SubagentStop",
      },
    };
  }
  return {
    sub: "post-tool-use",
    payload: {
      session_id: thread,
      cwd,
      tool_name: event.tool,
      tool_input: event.input ?? {},
      tool_use_id: event.toolUseID,
      tool_response: event.status === "done" ? event.output ?? null : { status: event.status, error: event.error },
      hook_event_name: "PostToolUse",
    },
  };
}

interface MessageLike {
  role?: string;
  content?: unknown;
}

// The turn's final reply: the text of its last assistant message.
export function lastAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike | null;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const parts = message.content
      .filter((block): block is { type: string; text: string } =>
        !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
      .map((block) => block.text);
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

// Amp ignores a plugin's `continue` after this many in a row with no user
// message between them (AgentEndResult.maxContinuations' default).
export const AMP_MAX_CONTINUATIONS = 5;

// Whether this turn end may become a `continue`: only a turn that finished
// (not one the operator cancelled or that failed) and only while Amp would
// still honour one. Otherwise am must not block, or it would take the queue
// for a turn that never comes.
export function mayContinue(status: unknown, continuations: number): boolean {
  return status === "done" && continuations < AMP_MAX_CONTINUATIONS;
}

// stop_hook_active mirrors Claude's: this stop follows a turn a stop block
// started. am_plain_stop asks am not to block it (see mayContinue).
export function agentEndHook(thread: string, cwd: string, messages: unknown, continued: boolean, plain = false): HookCall {
  const reply = lastAssistantText(messages);
  return {
    sub: "stop",
    payload: {
      session_id: thread,
      cwd,
      stop_hook_active: continued,
      ...(plain ? { am_plain_stop: true } : {}),
      ...(reply !== undefined ? { last_assistant_message: reply } : {}),
      hook_event_name: "Stop",
    },
  };
}

function parseHookOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// user-prompt-submit's additionalContext becomes the text Amp appends to the
// user's message: plan, decisions, verified-operator notes, inbox.
export function agentStartResult(stdout: string): { message: { content: string; display: boolean } } | undefined {
  const out = parseHookOutput(stdout);
  const specific = out?.hookSpecificOutput as { additionalContext?: unknown } | undefined;
  const context = typeof specific?.additionalContext === "string" ? specific.additionalContext.trim() : "";
  return context ? { message: { content: context, display: false } } : undefined;
}

// A stop hook's block ({decision:"block", reason}) keeps Claude working; Amp's
// equivalent is a continue turn with the reason as its message.
export function agentEndResult(stdout: string): { action: "continue"; userMessage: string } | undefined {
  const out = parseHookOutput(stdout);
  if (out?.decision !== "block" || typeof out.reason !== "string" || !out.reason.trim()) return undefined;
  return { action: "continue", userMessage: out.reason };
}

// am hook amp-drain prints the inbox text to hand over, or nothing.
export function drainMessage(stdout: string): string | undefined {
  const message = stdout.trim();
  return message ? message : undefined;
}

export const IDLE_POLL_MS = 3000;
const HOOK_TIMEOUT_MS = 30_000;

// `complete`: am ran and exited 0, so stdout is all it had to say.
function runHookResult(command: string[], sub: string, payload: HookPayload): Promise<{ stdout: string; complete: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (complete: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, complete });
    };
    let child;
    try {
      child = spawn(command[0]!, [...command.slice(1), "hook", sub], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    } catch {
      return resolve({ stdout: "", complete: false });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, HOOK_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

async function runHook(command: string[], sub: string, payload: HookPayload): Promise<string> {
  return (await runHookResult(command, sub, payload)).stdout;
}

// Amp's plugin API, as far as this plugin uses it. Typed loosely so the file
// needs no @ampcode/plugin package.
interface AmpThread {
  state: { get(): Promise<string> };
  appendUserMessage(message: { type: "user-message"; content: string }): Promise<void>;
}
interface AmpApi {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
  system?: { workspaceRoot?: { toString(): string } | null };
  helpers?: { filePathFromURI?: (uri: unknown) => string };
  threads?: { get(id: string): AmpThread };
  activeThread?: { current: { id: string } | null };
  onDispose?(callback: () => void): unknown;
  logger?: { log(...args: unknown[]): void };
}

function workspaceDir(amp: AmpApi): string {
  const root = amp.system?.workspaceRoot;
  if (root) {
    try {
      return amp.helpers?.filePathFromURI ? amp.helpers.filePathFromURI(root) : fileURLToPath(root.toString());
    } catch {
      // fall through
    }
  }
  return process.env.PWD ?? process.cwd();
}

export default function agentMotel(amp: AmpApi): void {
  const agent = managedAgent(process.env);
  if (!agent) return;
  const command = amCommand(process.env);
  const cwd = workspaceDir(amp);
  // The thread this agent is on: the first one this process sees, which am
  // records as the agent's session. Events from any other thread (a
  // subagent's, or one the operator switches to) aren't the agent's turn.
  let current: string | null = null;
  // Consecutive continue turns per thread (Amp caps them).
  const continuations = new Map<string, number>();
  const own = (thread: string | undefined): thread is string => {
    if (!thread) return false;
    current ??= thread;
    return thread === current;
  };

  amp.on("session.start", async (event) => {
    const thread = event?.thread?.id as string | undefined;
    if (!own(thread)) return;
    const call = sessionStartHook(thread, cwd);
    await runHook(command, call.sub, call.payload);
  });

  amp.on("agent.start", async (event) => {
    const thread = event?.thread?.id as string | undefined;
    if (!own(thread)) return undefined;
    const call = agentStartHook(thread, cwd, typeof event.message === "string" ? event.message : "");
    return agentStartResult(await runHook(command, call.sub, call.payload));
  });

  amp.on("agent.end", async (event) => {
    const thread = event?.thread?.id as string | undefined;
    if (!own(thread)) return undefined;
    const count = continuations.get(thread) ?? 0;
    const plain = !mayContinue(event.status, count);
    const call = agentEndHook(thread, cwd, event.messages, count > 0, plain);
    const stdout = await runHook(command, call.sub, call.payload);
    const result = plain ? undefined : agentEndResult(stdout);
    if (result) continuations.set(thread, count + 1);
    else continuations.delete(thread);
    return result;
  });

  amp.on("tool.call", async (event) => {
    const thread = event?.thread?.id as string | undefined;
    if (own(thread)) {
      const call = toolCallHook(thread, cwd, event);
      await runHook(command, call.sub, call.payload);
    }
    return { action: "allow" };
  });

  amp.on("tool.result", async (event) => {
    const thread = event?.thread?.id as string | undefined;
    if (!own(thread)) return undefined;
    const call = toolResultHook(thread, cwd, event);
    await runHook(command, call.sub, call.payload);
    return undefined;
  });

  // Messages sent while the agent is idle: no turn is coming to pick them up,
  // so poll and start one.
  let draining = false;
  const timer = setInterval(async () => {
    if (draining || !amp.threads) return;
    const thread = current ?? amp.activeThread?.current?.id ?? null;
    if (!thread) return;
    draining = true;
    try {
      const handle = amp.threads.get(thread);
      if ((await handle.state.get()) !== "idle") return;
      // Names this drain, so am returns exactly what it took if the
      // hand-over fails.
      const payload = { session_id: thread, cwd, handover: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
      const drained = await runHookResult(command, "amp-drain", payload);
      // am may have taken the queue and then been cut off: give it all back.
      const message = drained.complete ? drainMessage(drained.stdout) : undefined;
      try {
        if (!drained.complete) throw new Error("am hook amp-drain did not finish");
        if (message) await handle.appendUserMessage({ type: "user-message", content: message });
      } catch (error) {
        amp.logger?.log("agent-motel: idle delivery failed, returning it to am's queue", String(error));
        await runHook(command, "amp-requeue", payload);
      }
    } catch (error) {
      amp.logger?.log("agent-motel: idle delivery failed", String(error));
    } finally {
      draining = false;
    }
  }, IDLE_POLL_MS);
  amp.onDispose?.(() => clearInterval(timer));
}
