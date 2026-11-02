// When `am new` runs inside a Claude Code session (or the tmux server was
// started from one), spawned agents inherit the CLAUDE_CODE_* family and
// Claude Code treats them as nested child sessions — which silently disables
// conversation persistence, breaking `am resume`. Always launch agents
// through `env -u` for that family.
const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_AGENTAPI_EXE",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_GEMINI_DIR",
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_LS_VERSION",
  "ANTIGRAVITY_PROJECT_ID",
  "ANTIGRAVITY_SOURCE_METADATA",
  "ANTIGRAVITY_TRAJECTORY_ID",
];

const ANTIGRAVITY_NESTED_SESSION_VARS = new Set([
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_AGENTAPI_EXE",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_GEMINI_DIR",
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_LS_VERSION",
  "ANTIGRAVITY_PROJECT_ID",
  "ANTIGRAVITY_SOURCE_METADATA",
  "ANTIGRAVITY_TRAJECTORY_ID",
]);

export function nestedSessionVars(env: Record<string, string | undefined> = process.env): string[] {
  const vars = new Set(NESTED_SESSION_VARS);
  for (const key of Object.keys(env)) {
    if (
      key === "CLAUDECODE" ||
      key.startsWith("CLAUDE_CODE_") ||
      key === "CLAUDE_EFFORT" ||
      ANTIGRAVITY_NESTED_SESSION_VARS.has(key)
    ) {
      vars.add(key);
    }
  }
  return [...vars].sort();
}

export function scrubNestedSessionEnv(command: string[]): string[] {
  return ["env", ...nestedSessionVars().flatMap((v) => ["-u", v]), ...command];
}
