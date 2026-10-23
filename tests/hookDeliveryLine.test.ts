import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { writeAgent, type Provider } from "../src/state";

// The real hook, in a child process: each path that hands queued messages
// over through hook context also shows a display-only line in the pane.

const CLI = join(import.meta.dir, "../src/index.ts");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-delivery-line-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true" }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function seed(provider: Provider = "claude", status: "idle" | "working" = "working") {
  writeAgent({ name: "api", provider, status, dir: home, tmuxSession: "agentmgr-api-none", createdAt: "now", updatedAt: "now" });
}

function hook(event: string, payload: Record<string, unknown> = {}): Record<string, any> | null {
  const { AGENTMGR_PEER_INBOX: _ambient, ...env } = process.env;
  const result = Bun.spawnSync([process.execPath, CLI, "hook", event], {
    env: { ...env, AGENTMGR_AGENT: "api" },
    stdin: Buffer.from(JSON.stringify(payload)),
  });
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString().trim();
  return out ? JSON.parse(out) : null;
}

describe("hook delivery line", () => {
  test("UserPromptSubmit drain", () => {
    seed();
    queueAppend("api", "and yeah queue that up");
    queueAppend("api", "[am · from lead] check the build");
    const out = hook("user-prompt-submit", { prompt: "go" })!;
    expect(out.systemMessage).toBe('am: delivered 2 messages — operator: "and yeah queue that up"; from lead: "check the build"');
    expect(out.hookSpecificOutput.additionalContext).toContain("[am · from lead] check the build");
    expect(queueDepth("api")).toBe(0);
  }, 20_000);

  test("PostToolUse drain", () => {
    seed();
    queueAppend("api", "[am · from web] ping");
    const out = hook("post-tool-use", { tool_name: "Bash" })!;
    expect(out.systemMessage).toBe('am: delivered 1 message — from web: "ping"');
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  }, 20_000);

  test("Stop gate", () => {
    seed();
    queueAppend("api", "one more thing");
    const out = hook("stop")!;
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toBe('am: delivered 1 message — operator: "one more thing"');
  }, 20_000);

  test("nothing delivered, nothing shown; Codex gets no line", () => {
    seed();
    expect(hook("post-tool-use", { tool_name: "Bash" })).toBeNull();
    seed("codex");
    queueAppend("api", "[am · from web] ping");
    const out = hook("post-tool-use", { tool_name: "Bash" })!;
    expect(out.systemMessage).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("ping");
  }, 20_000);
});
