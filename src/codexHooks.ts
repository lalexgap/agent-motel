import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliEntrypoint } from "./settings";

// Codex hook event -> `am hook <arg>` subcommand. Codex cloned Claude Code's
// hook events, so these reuse the same handlers. No SessionEnd exists; the
// daemon's dead-session sweep covers exits. SessionStart fires lazily at the
// first turn (not TUI launch), so codex agents stay "starting" until then.
export const CODEX_HOOK_EVENTS: Record<string, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  // Codex has a dedicated approval event — no Notification-message sniffing
  // like the Claude side needs.
  PermissionRequest: "permission-request",
  Stop: "stop",
};

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexConfigFile(): string {
  return join(codexHome(), "config.toml");
}

const BLOCK_BEGIN = "# >>> agent-manager hooks — managed by `am`, do not edit by hand >>>";
const BLOCK_END = "# <<< agent-manager hooks <<<";

function tomlBasicString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Hooks must live persistently in config.toml rather than ride along as `-c`
// launch overrides: Codex's hook trust is keyed positionally to the config
// file the hook is defined in (file:event:group:handler), so a per-launch
// hook can never be durably trusted and is silently skipped. One persistent,
// $AGENTMGR_AGENT-guarded definition serves every agent — the hook command
// no-ops outside managed sessions — and survives trust review exactly once.
export function codexHooksBlock(): string {
  const lines: string[] = [BLOCK_BEGIN];
  lines.push(
    "# These run `am hook <event>` to track managed-agent status. They exit",
    "# immediately when $AGENTMGR_AGENT is unset, so normal codex sessions",
    "# are unaffected. Changing this block invalidates Codex's hook trust",
    "# and triggers a one-time re-review at the next managed launch.",
  );
  for (const [event, arg] of Object.entries(CODEX_HOOK_EVENTS)) {
    // Absolute bun + script paths: hooks run with whatever PATH codex has.
    const command = `"${process.execPath}" "${cliEntrypoint()}" hook ${arg}`;
    lines.push(
      "",
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      `type = "command"`,
      `command = ${tomlBasicString(command)}`,
    );
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

// The `command = "..."` lines are the only content Codex trusts (and the only
// thing whose change should invalidate that trust). Extract them, sorted, so
// two blocks can be compared while ignoring everything else.
function hookCommands(blockText: string): string[] {
  return [...blockText.matchAll(/^command = (.+)$/gm)].map((m) => m[1]!).sort();
}

function sameHookCommands(a: string, b: string): boolean {
  const ca = hookCommands(a);
  const cb = hookCommands(b);
  return ca.length === cb.length && ca.every((v, i) => v === cb[i]);
}

// Insert or refresh the managed block in $CODEX_HOME/config.toml.
//
// Codex records hook trust by appending [hooks.state] tables AFTER the user
// approves — and re-serializing the TOML drops those tables physically INSIDE
// our BLOCK markers. An exact-string compare therefore saw the block as
// "changed" on every launch, rewrote it, and sliced Codex's trust hashes back
// out — so the approval prompt returned every single time. Compare only the
// hook commands we own: as long as those are unchanged we leave the file
// untouched, preserving Codex's trust. A genuine command change still rewrites
// (and Codex re-reviews once, as intended).
export function ensureCodexHooks(): { changed: boolean; file: string } {
  const file = codexConfigFile();
  mkdirSync(codexHome(), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = codexHooksBlock();

  const begin = current.indexOf(BLOCK_BEGIN);
  const end = current.indexOf(BLOCK_END);
  let next: string;
  if (begin !== -1 && end !== -1 && end > begin) {
    const existing = current.slice(begin, end + BLOCK_END.length);
    if (sameHookCommands(existing, block)) return { changed: false, file };
    next = current.slice(0, begin) + block + current.slice(end + BLOCK_END.length);
  } else {
    const separator = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = current + separator + block + "\n";
  }
  writeFileSync(file, next);
  return { changed: true, file };
}
