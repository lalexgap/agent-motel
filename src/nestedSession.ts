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
];

export function nestedSessionVars(env: Record<string, string | undefined> = process.env): string[] {
  const vars = new Set(NESTED_SESSION_VARS);
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_EFFORT") {
      vars.add(key);
    }
  }
  return [...vars].sort();
}

export function scrubNestedSessionEnv(command: string[]): string[] {
  return ["env", ...nestedSessionVars().flatMap((v) => ["-u", v]), ...command];
}
