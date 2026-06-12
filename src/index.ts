#!/usr/bin/env bun
import { agentProvider, listAgents, readAgent, resolveAgent } from "./state";
import { queueDepth } from "./queue";
import { pick } from "./picker";
import { newCommand } from "./commands/new";
import { lsCommand, displayStatus, relativeTime, shortenHome, STATUS_ICONS } from "./commands/ls";
import { sendCommand, interruptCommand } from "./commands/send";
import { queueCommand } from "./commands/queue";
import { destroyAgent, rmCommand, stopAgent } from "./commands/rm";
import { jumpCommand, jumpPreviousCommand } from "./commands/jump";
import { hookCommand } from "./commands/hook";
import { resumeCommand, reviveAgent } from "./commands/resume";
import { transcriptCommand } from "./commands/transcript";
import { handoffCommand } from "./commands/handoff";
import { clickCommand } from "./commands/click";
import { isForwardable, remoteExec, stripHostArgs } from "./remote";
import { capturePane, hasSession, insideTmux } from "./tmux";
import { readSnapshot } from "./snapshots";
import { expandHome } from "./paths";
import { daemonCommand } from "./commands/daemon";
import { sidebarCommand, uiCommand } from "./commands/ui";
import { watchCommand } from "./commands/watch";
import { deliverCommand } from "./deliver";
import { runForegroundDaemon } from "./daemon";

const HELP = `am — manage and jump between coding agents (Claude Code & Codex)

usage:
  am                          split view: sidebar + live agent pane
                              (scrolling previews agents, enter/→ locks input
                               into the pane, ctrl-q back to the sidebar,
                               ctrl-n new, esc detach, ctrl-c quit)
  am pick                     classic fullscreen picker (enter attaches)
  am j <prefix>               jump to agent (prefix match)
  am -                        jump to previous agent
  am new <name> [-m msg] [--dir path | --worktree branch] [--codex] [--remote | --no-remote]
                              spawn a new agent in tmux and jump into it
                              (--no-jump to stay; non-TTY callers never jump;
                               --codex runs Codex instead of Claude Code)
  am new <name> --resume [session-id] | --continue
                              spawn an agent from an existing conversation
                              (bare --resume opens the provider's session picker)
  am resume <name> [-m msg]   restart an exited agent, resuming its conversation
  am ls [--json]              list agents with status and queue depth
  am send <name> <msg...>     queue a message, delivered when agent goes idle
  am send <name> <msg> --now  type it into the session immediately (steer)
  am interrupt <name> <msg>   abort current turn (Esc), then send message
  am queue <name> [--clear]   show or clear an agent's pending queue
  am transcript <name> [--full] [--out file]
                              render the agent's conversation as markdown
  am handoff <name> [new-name] [--to claude|codex]
                              hand the agent's work to a new agent on the other
                              provider, briefed with the rendered transcript
  am stop <name>              kill the session but keep state (resumable)
  am rm <name> [--clean]      kill the agent; --clean also removes its worktree
  am watch                    live status table (via the daemon)
  am daemon [start|stop|status]
                              manage the background daemon (auto-started by am new)

remote (agents running on a server, am on your laptop):
  am -H <host> <command...>   run any am command on <host> over ssh
                              (bare \`am -H box\` opens the full hub UI remotely)
  export AM_HOST=<host>       make every am command remote by default;
                              -L / --local forces a one-off local run
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["m", "message", "dir", "worktree", "to", "out", "host", "H"]);
const OPTIONAL_VALUE_FLAGS = new Set(["resume"]);

function parseArgs(argv: string[]): ParsedArgs {
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

function requirePositional(args: ParsedArgs, index: number, what: string): string {
  const value = args.positional[index];
  if (!value) throw new Error(`missing ${what} — see \`am help\``);
  return value;
}

// Remaining positionals after the agent name form the message, so quoting
// the whole message is optional: `am send api fix the tests` works.
function messageFrom(args: ParsedArgs): string {
  const message = args.positional.slice(1).join(" ");
  if (!message) throw new Error("missing message — see `am help`");
  return message;
}

async function pickerFlow(): Promise<void> {
  const load = () => {
    const agents = listAgents();
    return agents.map((a) => {
      const status = displayStatus(a);
      const queued = queueDepth(a.name);
      const provider = agentProvider(a);
      return {
        name: a.name,
        label: `${STATUS_ICONS[status]} ${a.name}`,
        right: [provider === "codex" ? "codex" : "", status, queued > 0 ? `· ${queued} queued` : ""]
          .filter(Boolean)
          .join(" "),
        search: `${a.task ?? ""} ${shortenHome(a.dir)} ${provider}`,
        meta: [
          `status   ${status}${queued > 0 ? ` (${queued} queued)` : ""}`,
          `provider ${provider}`,
          `dir      ${shortenHome(a.dir)}`,
          ...(a.worktreeBranch ? [`branch   ${a.worktreeBranch}`] : []),
          ...(a.task ? [`task     ${a.task}`] : []),
          `updated  ${relativeTime(a.updatedAt)}`,
          `created  ${relativeTime(a.createdAt)}`,
        ],
      };
    });
  };
  const handlers = {
    stop: (name: string) => {
      const agent = readAgent(name);
      if (agent) stopAgent(agent);
      return `stopped ${name} (resume with \`am resume ${name}\`)`;
    },
    remove: (name: string) => {
      const agent = readAgent(name);
      if (agent) destroyAgent(agent, { clean: false });
      return `removed ${name}`;
    },
    preview: (name: string) => {
      const agent = readAgent(name);
      if (!agent) return [];
      const live = capturePane(agent.tmuxSession, { colors: true });
      if (live) return live;
      const snapshot = readSnapshot(name);
      if (snapshot) return [`(last screen — ${displayStatus(agent)})`, ...snapshot];
      return [`(no live session — ${displayStatus(agent)})`];
    },
    create: async (name: string, task: string | undefined, dir: string | undefined) => {
      await newCommand({ name, message: task, dir: dir ? expandHome(dir) : undefined, jump: false, quiet: true });
      return name;
    },
    // Dir prompt prefill: the highlighted agent's dir (related work usually
    // lives in the same project), else where `am` was launched from.
    defaultDir: (highlighted: string | null) => {
      const agent = highlighted ? readAgent(highlighted) : null;
      return shortenHome(agent?.dir ?? process.cwd());
    },
  };

  // Hub loop: attach blocks until the user detaches (ctrl-q inside an agent),
  // then the picker reopens on the agent they just left. Inside tmux,
  // switch-client returns immediately, so jump once and exit instead.
  let cameFrom: string | undefined;
  while (true) {
    const chosen = await pick(load, handlers, cameFrom);
    if (!chosen) break;
    // Picking an exited/dead agent revives it before jumping in.
    const picked = readAgent(chosen);
    if (picked && !hasSession(picked.tmuxSession)) await reviveAgent(picked);
    jumpCommand(chosen);
    if (insideTmux()) break;
    if (load().length === 0) break;
    cameFrom = chosen;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // -H/--host (or AM_HOST, for an alias like `alias sam='AM_HOST=server am'`)
  // forwards the whole command to a remote am over ssh. Checked on the raw
  // argv since the flag may precede the command (`am -H server ls`).
  const hostIdx = argv.findIndex((a) => a === "--host" || a === "-H");
  const forceLocal = argv.includes("--local") || argv.includes("-L");
  const host = (hostIdx >= 0 ? argv[hostIdx + 1] : undefined) ?? process.env.AM_HOST;
  if (hostIdx >= 0 && !host) throw new Error("flag --host requires a value");
  const localArgv = stripHostArgs(argv);
  const [command, ...rest] = localArgv;
  if (host && !forceLocal && isForwardable(command)) remoteExec(host, localArgv);

  const args = parseArgs(rest);

  switch (command) {
    case undefined:
    case "ui":
      uiCommand();
      break;
    case "pick":
      await pickerFlow();
      break;
    case "new":
      await newCommand({
        name: requirePositional(args, 0, "agent name"),
        message: (args.flags.m ?? args.flags.message) as string | undefined,
        dir: args.flags.dir as string | undefined,
        worktree: args.flags.worktree as string | undefined,
        provider: args.flags.codex ? "codex" : undefined,
        resume: args.flags.resume as string | boolean | undefined,
        continue: !!args.flags.continue,
        jump: args.flags["no-jump"] ? false : undefined,
        remote: args.flags.remote ? true : args.flags["no-remote"] ? false : undefined,
      });
      break;
    case "resume":
      await resumeCommand(requirePositional(args, 0, "agent name"), {
        message: (args.flags.m ?? args.flags.message) as string | undefined,
        remote: args.flags.remote ? true : args.flags["no-remote"] ? false : undefined,
      });
      break;
    case "ls":
    case "list":
      lsCommand({ json: !!args.flags.json });
      break;
    case "j":
    case "jump":
      jumpCommand(requirePositional(args, 0, "agent name"));
      break;
    case "-":
      jumpPreviousCommand();
      break;
    case "send":
      sendCommand(requirePositional(args, 0, "agent name"), messageFrom(args), {
        now: !!args.flags.now,
      });
      break;
    case "interrupt":
    case "int":
      await interruptCommand(requirePositional(args, 0, "agent name"), messageFrom(args));
      break;
    case "queue":
    case "q":
      queueCommand(requirePositional(args, 0, "agent name"), { clear: !!args.flags.clear });
      break;
    case "transcript":
      transcriptCommand(requirePositional(args, 0, "agent name"), {
        full: !!args.flags.full,
        out: args.flags.out as string | undefined,
      });
      break;
    case "handoff":
      await handoffCommand(requirePositional(args, 0, "agent name"), {
        newName: args.positional[1],
        to: args.flags.to as string | undefined,
        full: !!args.flags.full,
        jump: args.flags["no-jump"] ? false : undefined,
      });
      break;
    case "stop": {
      const agent = resolveAgent(requirePositional(args, 0, "agent name"));
      stopAgent(agent);
      console.log(`stopped "${agent.name}" — resume with \`am resume ${agent.name}\``);
      break;
    }
    case "rm":
      rmCommand(requirePositional(args, 0, "agent name"), { clean: !!args.flags.clean });
      break;
    case "hook":
      await hookCommand(requirePositional(args, 0, "hook event"));
      break;
    case "daemon":
      await daemonCommand(args.positional[0]);
      break;
    case "watch":
      await watchCommand();
      break;
    case "__sidebar":
      await sidebarCommand();
      break;
    case "__daemon":
      runForegroundDaemon();
      return; // keep the process alive serving the socket
    case "__click":
      clickCommand(args.positional[0] ?? "", Number(args.positional[1] ?? -1), Number(args.positional[2] ?? -1));
      break;
    case "__deliver":
      await deliverCommand(requirePositional(args, 0, "agent name"));
      break;
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown command "${command}" — see \`am help\``);
  }
}

main().catch((error: Error) => {
  console.error(`am: ${error.message}`);
  process.exit(1);
});
