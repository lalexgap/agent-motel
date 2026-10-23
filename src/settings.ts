import { join } from "node:path";
import { ensureDirs, hookSettingsFile } from "./paths";
import { writeJsonAtomic } from "./fsutil";
import { loadConfig } from "./config";

// Claude Code hook event -> `am hook <arg>` subcommand.
export const HOOK_EVENTS: Record<string, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  // Tool events mark the agent working mid-turn. Crucially, PostToolUse is
  // what un-sticks needs-attention: approving a permission prompt fires no
  // event of its own, so without these the stale ⚠ lingers until the turn
  // ends.
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  Stop: "stop",
  Notification: "notification",
  SessionEnd: "session-end",
  // In-session subagents (the Task tool) have no pane of their own — these
  // two events are the only way to see that an agent fanned work out.
  SubagentStart: "subagent-start",
  SubagentStop: "subagent-stop",
  // Fires the moment Claude asks, alongside its own dialog; the hook relays
  // the request to `am serve` clients for a bounded wait (see
  // awaitPermissionDecision), so it needs a timeout past that wait.
  PermissionRequest: "permission-request",
};

// Headroom over the wait, so Claude never kills the hook mid-answer.
const PERMISSION_HOOK_SLACK_SECONDS = 30;

export function cliEntrypoint(): string {
  return join(import.meta.dir, "index.ts");
}

function hookTimeout(claudeEvent: string): { timeout?: number } {
  if (claudeEvent !== "PermissionRequest") return {};
  return { timeout: Math.max(0, Math.ceil(loadConfig().permissionWaitSeconds)) + PERMISSION_HOOK_SLACK_SECONDS };
}

export function buildHookSettings(): object {
  // Absolute bun + script paths: hooks run with whatever PATH Claude Code has,
  // so we can't rely on `am` being linked there.
  const command = (event: string) =>
    `"${process.execPath}" "${cliEntrypoint()}" hook ${event}`;

  return {
    // Peer messages arrive on the session's inbox socket; bypass-mode sessions
    // would otherwise hold each one behind a Deliver/Deny dialog.
    crossSessionInbound: "accept",
    hooks: Object.fromEntries(
      Object.entries(HOOK_EVENTS).map(([claudeEvent, arg]) => [
        claudeEvent,
        [{ hooks: [{ type: "command", command: command(arg), ...hookTimeout(claudeEvent) }] }],
      ]),
    ),
  };
}

export function writeHookSettings(): string {
  ensureDirs();
  const file = hookSettingsFile();
  // Atomic: two concurrent `am new` runs rewrite this file while Claude Code
  // parses it at startup — a torn read would launch an agent with no hooks.
  writeJsonAtomic(file, buildHookSettings());
  return file;
}
