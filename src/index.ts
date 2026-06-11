#!/usr/bin/env bun
import { listAgents, readAgent, resolveAgent } from "./state";
import { queueDepth } from "./queue";
import { pick } from "./picker";
import { newCommand } from "./commands/new";
import { lsCommand, displayStatus, relativeTime, shortenHome, STATUS_ICONS } from "./commands/ls";
import { sendCommand, interruptCommand } from "./commands/send";
import { queueCommand } from "./commands/queue";
import { destroyAgent, rmCommand, stopAgent } from "./commands/rm";
import { jumpCommand, jumpPreviousCommand } from "./commands/jump";
import { hookCommand } from "./commands/hook";
import { resumeCommand } from "./commands/resume";
import { capturePane, insideTmux } from "./tmux";
import { readSnapshot } from "./snapshots";
import { daemonCommand } from "./commands/daemon";
import { sidebarCommand, uiCommand } from "./commands/ui";
import { watchCommand } from "./commands/watch";
import { deliverCommand } from "./deliver";
import { runForegroundDaemon } from "./daemon";

const HELP = `am — manage and jump between Claude Code agents

usage:
  am                          interactive picker: filter, enter to jump, ctrl-n new
  am ui                       persistent split view: sidebar + live agent pane
                              (enter shows an agent, ctrl-q toggles focus,
                               esc detaches, ctrl-c quits)
  am j <prefix>               jump to agent (prefix match)
  am -                        jump to previous agent
  am new <name> [-m msg] [--dir path | --worktree branch]
                              spawn a new agent in tmux and jump into it
                              (--no-jump to stay; non-TTY callers never jump)
  am new <name> --resume [session-id] | --continue
                              spawn an agent from an existing conversation
                              (bare --resume opens Claude's session picker)
  am resume <name> [-m msg]   restart an exited agent, resuming its conversation
  am ls [--json]              list agents with status and queue depth
  am send <name> <msg...>     queue a message, delivered when agent goes idle
  am send <name> <msg> --now  type it into the session immediately (steer)
  am interrupt <name> <msg>   abort current turn (Esc), then send message
  am queue <name> [--clear]   show or clear an agent's pending queue
  am stop <name>              kill the session but keep state (resumable)
  am rm <name> [--clean]      kill the agent; --clean also removes its worktree
  am watch                    live status table (via the daemon)
  am daemon [start|stop|status]
                              manage the background daemon (auto-started by am new)
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["m", "message", "dir", "worktree"]);
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
    const nameWidth = Math.max(0, ...agents.map((a) => a.name.length));
    return agents.map((a) => {
      const status = displayStatus(a);
      const queued = queueDepth(a.name);
      return {
        name: a.name,
        label: `${STATUS_ICONS[status]} ${a.name.padEnd(nameWidth)}  ${status}${queued > 0 ? ` · ${queued} queued` : ""}`,
        search: `${a.task ?? ""} ${a.dir}`,
        meta: [
          `status   ${status}${queued > 0 ? ` (${queued} queued)` : ""}`,
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
    // ctrl-n in the picker: spawn in the directory `am` was launched from.
    create: async (name: string, task?: string) => {
      await newCommand({ name, message: task, jump: false, quiet: true });
      return name;
    },
  };

  // Hub loop: attach blocks until the user detaches (ctrl-q inside an agent),
  // then the picker reopens on the agent they just left. Inside tmux,
  // switch-client returns immediately, so jump once and exit instead.
  let cameFrom: string | undefined;
  while (true) {
    const chosen = await pick(load, handlers, cameFrom);
    if (!chosen) break;
    jumpCommand(chosen);
    if (insideTmux()) break;
    if (load().length === 0) break;
    cameFrom = chosen;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case undefined:
      await pickerFlow();
      break;
    case "new":
      await newCommand({
        name: requirePositional(args, 0, "agent name"),
        message: (args.flags.m ?? args.flags.message) as string | undefined,
        dir: args.flags.dir as string | undefined,
        worktree: args.flags.worktree as string | undefined,
        resume: args.flags.resume as string | boolean | undefined,
        continue: !!args.flags.continue,
        jump: args.flags["no-jump"] ? false : undefined,
      });
      break;
    case "resume":
      await resumeCommand(requirePositional(args, 0, "agent name"), {
        message: (args.flags.m ?? args.flags.message) as string | undefined,
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
    case "ui":
      uiCommand();
      break;
    case "__sidebar":
      await sidebarCommand();
      break;
    case "__daemon":
      runForegroundDaemon();
      return; // keep the process alive serving the socket
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
