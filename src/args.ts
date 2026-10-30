export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["m", "message", "dir", "worktree", "base", "model", "effort", "role", "sort", "description", "to", "new-name", "out", "host", "H", "port", "bind", "from", "report-to", "file", "timeout", "ssh-port", "limit", "agent-days", "trash-days", "status", "lines", "provider", "subagent"]);
const OPTIONAL_VALUE_FLAGS = new Set(["resume"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-") && arg !== "-") {
      const key = arg.replace(/^--?/, "");
      if (VALUE_FLAGS.has(key)) {
        const value = argv[++i];
        if (value === undefined) throw new Error(`flag --${key} requires a value`);
        flags[key] = value;
      } else if (OPTIONAL_VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        flags[key] = next !== undefined && !next.startsWith("-") ? argv[++i]! : true;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
