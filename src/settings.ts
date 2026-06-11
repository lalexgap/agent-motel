import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, hookSettingsFile } from "./paths";

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
};

export function cliEntrypoint(): string {
  return join(import.meta.dir, "index.ts");
}

export function buildHookSettings(): object {
  // Absolute bun + script paths: hooks run with whatever PATH Claude Code has,
  // so we can't rely on `am` being linked there.
  const command = (event: string) =>
    `"${process.execPath}" "${cliEntrypoint()}" hook ${event}`;

  return {
    hooks: Object.fromEntries(
      Object.entries(HOOK_EVENTS).map(([claudeEvent, arg]) => [
        claudeEvent,
        [{ hooks: [{ type: "command", command: command(arg) }] }],
      ]),
    ),
  };
}

export function writeHookSettings(): string {
  ensureDirs();
  const file = hookSettingsFile();
  writeFileSync(file, JSON.stringify(buildHookSettings(), null, 2) + "\n");
  return file;
}
