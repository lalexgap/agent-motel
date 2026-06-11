#!/usr/bin/env bun
import { listAgents } from "./state";
import { queueDepth } from "./queue";
import { pick } from "./picker";
import { newCommand } from "./commands/new";
import { lsCommand, displayStatus, STATUS_ICONS } from "./commands/ls";
import { sendCommand, interruptCommand } from "./commands/send";
import { queueCommand } from "./commands/queue";
import { rmCommand } from "./commands/rm";
import { jumpCommand, jumpPreviousCommand } from "./commands/jump";
import { hookCommand } from "./commands/hook";
import { daemonCommand } from "./commands/daemon";
import { watchCommand } from "./commands/watch";
import { deliverCommand } from "./deliver";
import { runForegroundDaemon } from "./daemon";

const HELP = `am — manage and jump between Claude Code agents

usage:
  am                          interactive picker: filter, enter to jump
  am j <prefix>               jump to agent (prefix match)
  am -                        jump to previous agent
  am new <name> [-m msg] [--dir path | --worktree branch]
                              spawn a new agent in tmux
  am ls [--json]              list agents with status and queue depth
  am send <name> <msg...>     queue a message, delivered when agent goes idle
  am send <name> <msg> --now  type it into the session immediately (steer)
  am interrupt <name> <msg>   abort current turn (Esc), then send message
  am queue <name> [--clear]   show or clear an agent's pending queue
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
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("no agents — create one with `am new <name>`");
    return;
  }
  const nameWidth = Math.max(...agents.map((a) => a.name.length));
  const items = agents.map((a) => {
    const status = displayStatus(a);
    const queued = queueDepth(a.name);
    return {
      name: a.name,
      label: `${STATUS_ICONS[status]} ${a.name.padEnd(nameWidth)}  ${status.padEnd(15)} ${queued > 0 ? `${queued} queued` : ""}`,
    };
  });
  const chosen = await pick(items);
  if (chosen) jumpCommand(chosen);
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
