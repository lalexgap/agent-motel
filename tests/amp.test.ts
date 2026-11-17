import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agentMotel, {
  agentEndHook,
  agentEndResult,
  agentStartHook,
  agentStartResult,
  amCommand,
  drainMessage,
  lastAssistantText,
  managedAgent,
  sessionStartHook,
  toolCallHook,
  toolResultHook,
} from "../src/amp/agent-motel";
import { AMP_PLUGIN_SOURCE, ampAgentEnv, ampPluginFile, ensureAmpPlugin } from "../src/ampPlugin";
import { ampCatalog, validateSelection } from "../src/catalog";
import { ensureDirs } from "../src/paths";
import { ampModelArgs, buildLaunchCommand, buildResumeCommand } from "../src/providers";
import { queueAppend, queueDepth } from "../src/queue";
import { writeAgent, type AgentState } from "../src/state";
import { parseArgs } from "../src/args";

describe("amp launch commands", () => {
  test("model and effort pick an Amp mode", () => {
    expect(ampModelArgs({})).toEqual([]);
    expect(ampModelArgs({ effort: "low" })).toEqual(["-m", "low"]);
    expect(ampModelArgs({ effort: "high" })).toEqual(["-m", "high"]);
    expect(ampModelArgs({ effort: "xhigh" })).toEqual(["-m", "ultra"]);
    expect(ampModelArgs({ effort: "max" })).toEqual(["-m", "ultra"]);
    expect(ampModelArgs({ model: "ultra", effort: "low" })).toEqual(["-m", "ultra"]);
    expect(ampModelArgs({ model: "openai/gpt-6-astra", effort: "high" })).toEqual(["--model", "openai/gpt-6-astra", "--effort", "high"]);
  });

  test("a new agent pipes the primer and task in as the first message", () => {
    const { command, deferredMessage } = buildLaunchCommand("amp", "worker", { message: "do the thing", effort: "medium" });
    expect(command.slice(0, 3)).toEqual(["sh", "-c", 'm=$1; shift; printf "%s" "$m" | exec "$@"']);
    expect(command[3]).toBe("am-amp");
    expect(command[4]).toContain('managed agent named "worker"');
    expect(command[4]).toEndWith("# Your task\n\ndo the thing");
    expect(command.slice(5)).toEqual(["amp", "--no-ide", "-m", "medium"]);
    expect(deferredMessage).toBeUndefined();
  });

  test("without a task, only a role or report target sends the primer", () => {
    expect(buildLaunchCommand("amp", "worker", {}).command).toEqual(["amp", "--no-ide"]);
    const reporting = buildLaunchCommand("amp", "worker", { reportTo: "lead" }).command;
    expect(reporting[0]).toBe("sh");
    expect(reporting[4]).toContain('You are reporting to "lead"');
  });

  test("adopting a thread continues it and queues the message", () => {
    expect(buildLaunchCommand("amp", "worker", { resume: "T-1", message: "next" })).toEqual({
      command: ["amp", "--no-ide", "threads", "continue", "T-1"],
      deferredMessage: "next",
    });
    expect(buildLaunchCommand("amp", "worker", { continue: true }).command).toEqual(["amp", "--no-ide", "threads", "continue", "--last"]);
    expect(() => buildLaunchCommand("amp", "worker", { resume: true })).toThrow(/thread id/);
  });

  test("resume continues the recorded thread", () => {
    const agent = { name: "worker", provider: "amp", sessionId: "T-abc", dir: "/x" } as AgentState;
    expect(buildResumeCommand("amp", agent, { message: "hi" })).toEqual({
      command: ["amp", "--no-ide", "threads", "continue", "T-abc"],
      deferredMessage: "hi",
    });
    const fresh = { name: "worker", provider: "amp", dir: "/x" } as AgentState;
    expect(buildResumeCommand("amp", fresh, {}).command).toEqual(["amp", "--no-ide", "threads", "continue", "--last"]);
  });

  test("--amp selects the provider", () => {
    expect(parseArgs(["new", "x", "--amp"]).flags.amp).toBe(true);
    expect(() => parseArgs(["new", "x", "--amp", "--codex"])).toThrow(/only one provider/);
    expect(() => parseArgs(["new", "x", "--provider", "amp"])).not.toThrow();
  });

  test("the catalog accepts modes and efforts, and warns on unknown models", () => {
    const catalog = ampCatalog();
    expect(validateSelection(catalog, { model: "ultra" })).toEqual([]);
    expect(validateSelection(catalog, { effort: "xhigh" })).toEqual([]);
    expect(validateSelection(catalog, { effort: "bogus" })[0]?.fatal).toBe(true);
    expect(validateSelection(catalog, { model: "openai/gpt-6-astra" })[0]?.fatal).toBe(false);
  });
});

describe("amp plugin gating", () => {
  test("acts only for an Amp process am launched as that agent", () => {
    expect(managedAgent({})).toBeNull();
    // A Claude/Codex agent running `amp -x` passes AGENTMGR_AGENT on.
    expect(managedAgent({ AGENTMGR_AGENT: "claude-agent" })).toBeNull();
    expect(managedAgent({ AGENTMGR_AGENT: "a", AGENTMGR_AMP_AGENT: "b" })).toBeNull();
    expect(managedAgent({ AGENTMGR_AGENT: "a", AGENTMGR_AMP_AGENT: "a" })).toBe("a");
    expect(managedAgent({ ...ampAgentEnv("w"), AGENTMGR_AGENT: "w" })).toBe("w");
  });

  test("registers nothing when not armed", () => {
    const saved = { agent: process.env.AGENTMGR_AGENT, amp: process.env.AGENTMGR_AMP_AGENT };
    process.env.AGENTMGR_AGENT = "someone";
    delete process.env.AGENTMGR_AMP_AGENT;
    try {
      const events: string[] = [];
      agentMotel({ on: (event: string) => events.push(event) });
      expect(events).toEqual([]);
    } finally {
      if (saved.agent === undefined) delete process.env.AGENTMGR_AGENT;
      else process.env.AGENTMGR_AGENT = saved.agent;
      if (saved.amp !== undefined) process.env.AGENTMGR_AMP_AGENT = saved.amp;
    }
  });

  test("runs the am that launched the agent, else am on PATH", () => {
    expect(amCommand({ AGENTMGR_AM_CMD: JSON.stringify(["/bin/bun", "/am/index.ts"]) })).toEqual(["/bin/bun", "/am/index.ts"]);
    expect(amCommand({ AGENTMGR_AM_CMD: "garbage" })).toEqual(["am"]);
    expect(amCommand({})).toEqual(["am"]);
  });
});

describe("amp event mapping", () => {
  test("session and prompt events carry the thread as the session id", () => {
    expect(sessionStartHook("T-1", "/w")).toEqual({
      sub: "session-start",
      payload: { session_id: "T-1", cwd: "/w", source: "startup", hook_event_name: "SessionStart" },
    });
    expect(agentStartHook("T-1", "/w", "hello")).toEqual({
      sub: "user-prompt-submit",
      payload: { session_id: "T-1", cwd: "/w", prompt: "hello", hook_event_name: "UserPromptSubmit" },
    });
  });

  test("tool events map onto the tool hooks", () => {
    const call = { toolUseID: "tu-1", tool: "shell_command", input: { command: "ls" } };
    expect(toolCallHook("T-1", "/w", call)).toEqual({
      sub: "pre-tool-use",
      payload: { session_id: "T-1", cwd: "/w", tool_name: "shell_command", tool_input: { command: "ls" }, tool_use_id: "tu-1", hook_event_name: "PreToolUse" },
    });
    const result = toolResultHook("T-1", "/w", { ...call, status: "done", output: { exitCode: 0 } });
    expect(result.sub).toBe("post-tool-use");
    expect(result.payload.tool_response).toEqual({ exitCode: 0 });
    expect(toolResultHook("T-1", "/w", { ...call, status: "error", error: "boom" }).payload.tool_response).toEqual({ status: "error", error: "boom" });
  });

  test("the Task tool is a subagent's lifetime", () => {
    const call = { toolUseID: "tu-9", tool: "Task", input: { prompt: "look" } };
    expect(toolCallHook("T-1", "/w", call)).toEqual({
      sub: "subagent-start",
      payload: { session_id: "T-1", cwd: "/w", agent_id: "tu-9", agent_type: "Task", hook_event_name: "SubagentStart" },
    });
    const stop = toolResultHook("T-1", "/w", { ...call, status: "done", output: "found it" });
    expect(stop.sub).toBe("subagent-stop");
    expect(stop.payload).toMatchObject({ agent_id: "tu-9", last_assistant_message: "found it" });
  });

  test("a turn end reports the last reply and whether a block started it", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "DONE" }] },
      { role: "info", content: [] },
    ];
    expect(lastAssistantText(messages)).toBe("DONE");
    expect(lastAssistantText(undefined)).toBeUndefined();
    expect(agentEndHook("T-1", "/w", messages, true)).toEqual({
      sub: "stop",
      payload: { session_id: "T-1", cwd: "/w", stop_hook_active: true, last_assistant_message: "DONE", hook_event_name: "Stop" },
    });
  });

  test("hook output becomes Amp results", () => {
    const context = JSON.stringify({ systemMessage: "line", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "[am plan] …" } });
    expect(agentStartResult(context)).toEqual({ message: { content: "[am plan] …", display: false } });
    expect(agentStartResult("")).toBeUndefined();
    expect(agentStartResult("not json")).toBeUndefined();
    expect(agentEndResult(JSON.stringify({ decision: "block", reason: "[am inbox] read this" }))).toEqual({
      action: "continue",
      userMessage: "[am inbox] read this",
    });
    expect(agentEndResult(JSON.stringify({ decision: "approve" }))).toBeUndefined();
    expect(agentEndResult("")).toBeUndefined();
    expect(drainMessage("  \n")).toBeUndefined();
    expect(drainMessage("[am inbox] hi\n")).toBe("[am inbox] hi");
  });
});

describe("ensureAmpPlugin", () => {
  let home: string;
  const savedHome = process.env.HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-amp-plugin-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("installs the shipped plugin once and refreshes a stale copy", () => {
    expect(ampPluginFile()).toBe(join(home, ".config", "amp", "plugins", "agent-motel.ts"));
    expect(ensureAmpPlugin().changed).toBe(true);
    expect(readFileSync(ampPluginFile(), "utf8")).toBe(readFileSync(AMP_PLUGIN_SOURCE, "utf8"));
    expect(ensureAmpPlugin().changed).toBe(false);
    writeFileSync(ampPluginFile(), "// old");
    expect(ensureAmpPlugin().changed).toBe(true);
  });
});

describe("am hook amp-drain", () => {
  const CLI = join(import.meta.dir, "../src/index.ts");
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-amp-drain-"));
    process.env.AGENTMGR_HOME = home;
    ensureDirs();
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true" }));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  function seed(provider: "amp" | "claude", sessionId?: string) {
    writeAgent({ name: "api", provider, status: "idle", dir: home, tmuxSession: "agentmgr-api-none", sessionId, createdAt: "now", updatedAt: "now" });
  }

  function drain(payload: Record<string, unknown> = {}): string {
    const result = Bun.spawnSync([process.execPath, CLI, "hook", "amp-drain"], {
      env: { ...process.env, AGENTMGR_AGENT: "api" },
      stdin: Buffer.from(JSON.stringify(payload)),
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  }

  test("hands an idle Amp agent its queue as one inbox prompt", () => {
    seed("amp", "T-1");
    queueAppend("api", "[am · from lead] ping");
    const out = drain({ session_id: "T-1" });
    expect(out).toStartWith("[am inbox] You have 1 message:");
    expect(out).toContain("[am · from lead] ping");
    expect(queueDepth("api")).toBe(0);
    expect(drain({ session_id: "T-1" })).toBe("");
  }, 20_000);

  test("ignores other threads and other providers", () => {
    seed("amp", "T-1");
    queueAppend("api", "hello");
    expect(drain({ session_id: "T-other" })).toBe("");
    seed("claude");
    expect(drain({})).toBe("");
    expect(queueDepth("api")).toBe(1);
  }, 20_000);
});
