import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { shQuote } from "./tmux";
import { sshRunAsync, type SshResult } from "./remote";

export interface DirCompletion {
  // The input after completion. Unchanged when there's nothing to complete.
  value: string;
  // Candidate basenames to display when the completion is ambiguous; empty
  // when a unique completion was applied or there was nothing to match.
  candidates: string[];
}

function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0]!;
  for (const s of strs) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

// Expand a leading ~ against the LOCAL home (only used for the local backend;
// the remote backend expands ~ against the remote home instead).
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

// Parse a path input into the parent directory to list, the prefix to match
// within it, and the literal head (everything up to and including the last
// slash) that completion preserves verbatim. ~ is kept literal in `dir` so
// each backend can expand it against the right home.
export function splitDirInput(input: string): { dir: string; prefix: string; head: string } {
  const dir = input.endsWith("/") ? input || "/" : dirname(input) || ".";
  const slash = input.lastIndexOf("/");
  const prefix = slash >= 0 ? input.slice(slash + 1) : input;
  const head = slash >= 0 ? input.slice(0, slash + 1) : "";
  return { dir, prefix, head };
}

// Turn a directory's child names into a completion of `input`. Shared by the
// local and remote backends so both behave identically: one match completes
// and gets a trailing "/" so the next Tab descends; several complete to the
// common prefix and surface the candidates for display; none is a no-op.
export function resolveDirCompletion(entries: string[], input: string): DirCompletion {
  const { prefix, head } = splitDirInput(input);
  const matches = entries.filter((n) => n.startsWith(prefix)).sort();
  if (matches.length === 0) return { value: input, candidates: [] };
  if (matches.length === 1) return { value: head + matches[0] + "/", candidates: [] };
  return { value: head + commonPrefix(matches), candidates: matches };
}

// Tab-completion for the Dir field against the LOCAL filesystem (directories
// only). Reads the parent directory (expanding ~ against the local home) and
// resolves against the raw input, which keeps the literal head (including ~)
// untouched — completion only ever rewrites the final path segment.
export function completeDir(input: string): DirCompletion {
  const { dir } = splitDirInput(input);
  let entries: string[];
  try {
    entries = readdirSync(expandTilde(dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { value: input, candidates: [] };
  }
  return resolveDirCompletion(entries, input);
}

// The runner completeDirRemote talks to — sshRunAsync in production, a fake in
// tests. Matches sshRunAsync's shape.
export type RemoteRunner = (
  host: string,
  command: string,
  opts?: { timeoutMs?: number },
) => Promise<SshResult>;

// Lists subdirectories of $1 whose name starts with $2, one basename per line.
// Both args arrive as positional parameters (never re-parsed as shell code), so
// a path or prefix with spaces/metacharacters can't inject. ~ is expanded
// against the REMOTE $HOME; the unquoted glob does the prefix match and the
// trailing "/" plus the -d guard keep it to directories (and drop the literal
// pattern when nothing matches, since nullglob is off).
const REMOTE_LIST_SCRIPT =
  'd=$1; p=$2; case "$d" in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac; ' +
  'cd "$d" 2>/dev/null || exit 0; ' +
  'for e in "$p"*/; do [ -d "$e" ] && printf "%s\\n" "${e%/}"; done';

// Tab-completion for the Dir field against a REMOTE host over ssh — same
// behavior as completeDir, but the directory listing comes from one ssh
// round-trip (mux-reused, so warm calls are cheap). Throws when the host is
// unreachable or the call times out; an empty/missing directory is a no-op,
// not an error.
export async function completeDirRemote(
  host: string,
  input: string,
  opts: { timeoutMs?: number; run?: RemoteRunner } = {},
): Promise<DirCompletion> {
  const run = opts.run ?? sshRunAsync;
  const { dir, prefix } = splitDirInput(input);
  const command = ["bash", "-c", REMOTE_LIST_SCRIPT, "_", dir, prefix].map(shQuote).join(" ");
  const res = await run(host, command, { timeoutMs: opts.timeoutMs ?? 4000 });
  if (res.exitCode !== 0) {
    const detail =
      res.stderr.trim().split("\n").filter(Boolean).pop() ||
      (res.exitCode === 124 ? "timed out" : `exit ${res.exitCode}`);
    throw new Error(`couldn't reach ${host}: ${detail}`);
  }
  const entries = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return resolveDirCompletion(entries, input);
}
