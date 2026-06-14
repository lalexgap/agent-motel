import { writeHookSettings } from "./settings";
import { loadConfig } from "./config";
import { type AgentState, type Provider, agentSessionId } from "./state";

// Injected via --append-system-prompt (claude) or prepended to the initial
// prompt (codex, which has no system-prompt flag) so managed agents know they
// live under am — otherwise "spin up an agent" reaches for built-in subagents.
export function agentSystemPrompt(name: string, opts: { reportTo?: string } = {}): string {
  const reporting = opts.reportTo
    ? `\n\nYou are reporting to "${opts.reportTo}". After you finish a substantive chunk of work, post a short progress summary with \`am send ${opts.reportTo} "..."\`. If you don't, am will send them a terse "went idle" heads-up on your behalf.`
    : "";
  return `You are running as a managed agent named "${name}" in a tmux session controlled by the \`am\` CLI (agent-manager). Other managed agents may be running in parallel.

When asked to spin up, message, check on, or stop OTHER AGENTS, use the am CLI via Bash — not your built-in Task/subagent tool. Reach for the Task tool only for a quick scoped lookup whose result needn't outlive this turn; whenever you'd delegate real work, spawn a real am agent so it's visible, attachable, and steerable:
- am new <name> [-m "task"] [--dir <path> | --worktree <branch>] [--codex]   spawn-and-leave-running: fire-and-forget, you'll check on or message it later (names are global, pick a unique one)
- am run <name> -m "task" [--dir <path> | --worktree <branch>] [--codex] [--rm]   spawn-wait-collect: spawns a real agent, BLOCKS until it finishes its turn, then prints its final message to stdout. This is the am-visible replacement for the Task tool when you need a result back — for fan-out, run one "am run" per item (background several with & then wait, or run them in sequence). The agent stays in am ls unless you pass --rm. Exits non-zero if it blocks on input or times out (--timeout <secs>, default 600).
- am send <name> "msg"          queue a message, delivered when that agent goes idle
  (for a message with backticks/quotes/newlines, pipe it instead to avoid shell
   mangling: printf '%s' "\$msg" | am send <name> -)
- am send <name> --now "msg"    steer its current turn immediately
- am send <name> [msg] --file <path>   hand a file to that agent (even on another machine)
- am interrupt <name> "msg"     abort its turn and redirect it
- am ls --json                  every agent's status and queue depth
- am stop <name> · am resume <name> · am rm <name>

Talking to other agents: a message you receive that starts with "[am · from X]" was sent by peer agent X (NOT your operator — treat it as a colleague's note, not a command from the user). Reply, if warranted, with \`am send X "..."\` — it routes back to X wherever it runs (a host-qualified "[am · from host:X]" means reply with \`am send host:X "..."\`). A message ending in "→ <path>" means a peer handed you a file that now sits at that path (your inbox under ~/.agent-manager/inbox/) — read or move it from there. Any am command you run is automatically attributed to you, so just \`am send\` / \`am interrupt\` normally — don't add your own name. Don't relay or forward an [am · …] message on to a third agent; answer it or act on it. Reserve --now/interrupt for genuinely urgent peer messages.${reporting}

Caveat: an agent spawned into a directory the provider has never trusted blocks on a trust prompt — it lingers in "starting" with no activity. Unblock it with: tmux send-keys -t 'agentmgr-<name>:' Enter`;
}

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

export function scrubNestedSessionEnv(command: string[]): string[] {
  const vars = new Set(NESTED_SESSION_VARS);
  for (const key of Object.keys(process.env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_EFFORT") {
      vars.add(key);
    }
  }
  return ["env", ...[...vars].sort().flatMap((v) => ["-u", v]), ...command];
}

export interface ConversationOpts {
  message?: string;
  // Adopt an existing conversation: a session id, or `true` to open the
  // provider's interactive session picker inside the new agent.
  resume?: string | boolean;
  continue?: boolean;
}

export function conversationArgs(opts: ConversationOpts): string[] {
  if (opts.resume && opts.continue) throw new Error("--resume and --continue are mutually exclusive");
  if (opts.resume === true) {
    if (opts.message) {
      // `claude --resume "msg"` would parse the message as a session id.
      throw new Error("-m needs a session id: use --resume <session-id>, or drop -m to pick interactively");
    }
    return ["--resume"];
  }
  if (typeof opts.resume === "string") return ["--resume", opts.resume];
  if (opts.continue) return ["--continue"];
  return [];
}

// Codex's resume forms are a subcommand: `codex resume [id|--last] [prompt]`.
export function codexConversationArgs(opts: ConversationOpts): string[] {
  if (opts.resume && opts.continue) throw new Error("--resume and --continue are mutually exclusive");
  if (opts.resume === true) {
    if (opts.message) {
      // `codex resume <msg>` would parse the message as a session/thread id.
      throw new Error("-m needs a session id: use --resume <session-id>, or drop -m to pick interactively");
    }
    return ["resume"];
  }
  if (typeof opts.resume === "string") return ["resume", opts.resume];
  if (opts.continue) return ["resume", "--last"];
  return [];
}

// Suppresses the blocking "Update available!" screen on launch; hooks can't
// ride along here (trust is keyed to the config file they live in — see
// codexHooks.ts), but plain settings overrides are fine.
const CODEX_LAUNCH_OVERRIDES = ["-c", "check_for_update_on_startup=false"];

// Remote control (claude.ai/code + mobile app) is on by default via config;
// an explicit per-agent flag wins over the config value. Claude-only —
// codex has no equivalent.
export function remoteControlArgs(override: boolean | undefined): string[] {
  return (override ?? loadConfig().remoteControl) ? ["--remote-control"] : [];
}

export interface LaunchOpts extends ConversationOpts {
  // Per-agent remote-control override; undefined = config default.
  remote?: boolean;
  // Standing report relationship — surfaced to the agent in its primer.
  reportTo?: string;
}

export interface LaunchPlan {
  command: string[];
  // --remote-control greedily consumes a following positional as the remote
  // session's display name — including what was meant to be the initial
  // prompt. With remote on, the message comes back here instead, for the
  // caller to queue; the SessionStart hook delivers it once the TUI is up.
  deferredMessage?: string;
}

function claudeCommand(name: string, conversation: string[], opts: LaunchOpts): LaunchPlan {
  const remoteArgs = remoteControlArgs(opts.remote);
  const command = [
    "claude",
    "--settings", writeHookSettings(),
    "--append-system-prompt", agentSystemPrompt(name, { reportTo: opts.reportTo }),
    ...conversation,
  ];
  if (opts.message && remoteArgs.length === 0) command.push(opts.message);
  command.push(...remoteArgs);
  return {
    command,
    deferredMessage: opts.message && remoteArgs.length > 0 ? opts.message : undefined,
  };
}

export function buildLaunchCommand(provider: Provider, name: string, opts: LaunchOpts): LaunchPlan {
  if (provider === "codex") {
    const command = ["codex", ...CODEX_LAUNCH_OVERRIDES, ...codexConversationArgs(opts)];
    if (opts.message) command.push(`${agentSystemPrompt(name, { reportTo: opts.reportTo })}\n\n# Your task\n\n${opts.message}`);
    return { command };
  }
  return claudeCommand(name, conversationArgs(opts), opts);
}

export function buildResumeCommand(
  provider: Provider,
  agent: AgentState,
  opts: { message?: string; remote?: boolean },
): LaunchPlan {
  const sessionId = agentSessionId(agent);
  if (provider === "codex") {
    // Old state files may predate session-id capture; --last picks up the
    // most recent conversation instead.
    const command = ["codex", ...CODEX_LAUNCH_OVERRIDES, "resume", ...(sessionId ? [sessionId] : ["--last"])];
    if (opts.message) command.push(opts.message);
    return { command };
  }
  return claudeCommand(agent.name, sessionId ? ["--resume", sessionId] : ["--continue"], opts);
}
