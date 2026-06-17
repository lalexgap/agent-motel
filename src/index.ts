#!/usr/bin/env bun
import { hostname } from "node:os";
import { agentProvider, listAgents, readAgent, resolveAgent, type Provider } from "./state";
import { queueDepth } from "./queue";
import { pick, type PickerHandlers } from "./picker";
import { newCommand } from "./commands/new";
import { runCommand } from "./commands/run";
import { lsCommand, displayStatus, relativeTime, shortenHome, STATUS_ICONS } from "./commands/ls";
import { sendCommand, interruptCommand } from "./commands/send";
import { reportCommand } from "./commands/report";
import { sendFileCommand } from "./commands/sendfile";
import { commsCommand } from "./commands/comms";
import { outboxAckCommand, outboxClaimCommand, outboxCommand, outboxTakeCommand } from "./commands/outbox";
import { queueCommand } from "./commands/queue";
import { destroyAgent, rmCommand, stopAgent } from "./commands/rm";
import { restoreCommand } from "./commands/restore";
import { jumpCommand, jumpPreviousCommand } from "./commands/jump";
import { hookCommand } from "./commands/hook";
import { resumeCommand, reviveAgent } from "./commands/resume";
import { transcriptCommand } from "./commands/transcript";
import { handoffCommand } from "./commands/handoff";
import { clickCommand } from "./commands/click";
import { cdCommand, exportCommand, importCommand, moveCommand } from "./commands/move";
import { cdHandler, cloneHandler, handoffHandler, moveHandler } from "./commands/fleetActions";
import { isForwardable, remoteExec, sshAm, sshAmInteractive, stripHostArgs } from "./remote";
import { resolveSender } from "./comms";
import { resolveTarget } from "./route";
import { cachedRemotePreview, cachedRemoteRow, fleetPickerItems, fleetRows, splitFleetKey, shortHost, toggleGroupMode } from "./fleet";
import { loadConfig } from "./config";
import { capturePane, hasSession, insideTmux } from "./tmux";
import { readSnapshot } from "./snapshots";
import { expandHome } from "./paths";
import { daemonCommand } from "./commands/daemon";
import { serveCommand, tokenCommand } from "./commands/serve";
import { sidebarCommand, uiCommand } from "./commands/ui";
import { watchCommand } from "./commands/watch";
import { deliverCommand } from "./deliver";
import { runForegroundDaemon } from "./daemon";
import { runTunnel } from "./tunnel";
import { runMcpServer } from "./mcp/server";

const HELP = `am — manage and jump between coding agents (Claude Code & Codex)

usage:
  am                          split view: sidebar + live agent pane
                              (scrolling previews agents, enter/→ locks input
                               into the pane, ctrl-q back to the sidebar,
                               ctrl-n new, esc detach, ctrl-c quit)
  am pick                     classic fullscreen picker (enter attaches)
  am j <prefix>               jump to agent (prefix match)
  am -                        jump to previous agent
  am new <name> [-m msg] [--dir path] [--codex] [--remote | --no-remote]
                [--model <m>] [--effort <level>]
                              spawn a new agent in tmux and jump into it
                              (--no-jump to stay; non-TTY callers never jump;
                               --codex runs Codex instead of Claude Code;
                               --model / --effort override the provider defaults)
                              git repos get a fresh worktree on branch am/<name>
                              by default — --in-place uses the dir as-is,
                              --worktree <branch> picks the branch
                              (--report-to <t> / --report make it report progress
                               to <t> / to the agent that spawned it)
  am new <name> --resume [session-id] | --continue
                              spawn an agent from an existing conversation
                              (bare --resume opens the provider's session picker)
  am run <name> -m msg [--dir path] [--worktree b] [--codex]
                       [--timeout secs] [--rm] [--json]
                              spawn a real agent, wait for its turn, print its
                              final message (for fan-out: the agent stays in
                              am ls unless --rm; exit 1 if blocked/timed out)
  am resume <name> [-m msg]   restart an exited agent, resuming its conversation
  am ls [--json]              list agents with status and queue depth
  am send <name> <msg...>     queue a message, delivered when agent goes idle
  am send <name> <msg> --now  type it into the session immediately (steer)
  am send <name> -            read the message body from stdin (no shell quoting
                              headaches: \`am transcript x | am send y -\`)
  am send <name> [msg] --file <path>
                              hand a file to the agent (works across machines):
                              lands in its inbox, with a note pointing at it
  am interrupt <name> <msg>   abort current turn (Esc), then send message
                              (sends from inside an agent are auto-attributed:
                               the recipient sees "[am · from <you>] …")
  am report <name> --to <t>   make <name> report progress to <t> (--clear drops
                              it; bare \`am report <name>\` shows the relationship)
  am comms <name>             recent messages to/from an agent
  am outbox [--clear]         messages queued here for an unreachable target
                              (store-and-forward; a collector picks them up)
  am queue <name> [--clear]   show or clear an agent's pending queue
  am transcript <name> [--full] [--out file]
                              render the agent's conversation as markdown
  am handoff <name> [new-name] [--to claude|codex]
                              hand the agent's work to a new agent on the other
                              provider, briefed with the rendered transcript
  am cd <name> <dir>          change the agent's directory: conversation moves
                              with it (git targets get a fresh worktree;
                              --in-place uses the dir as-is)
  am stop <name>              kill the session but keep state (resumable)
  am rm <name> [--clean]      kill the agent; --clean also removes its worktree
                              (the state is snapshotted to trash first)
  am restore [<name>]         bring back a removed agent (resumes its
                              conversation); no name lists what's recoverable
                              (--no-resume just re-registers it)
  am watch                    live status table (via the daemon)
  am daemon [start|stop|status]
                              manage the background daemon (auto-started by am new)
  am serve [--port n] [--bind addr]
                              HTTP API + installable PWA for phones (token-gated;
                              put it behind a tailnet/Caddy — it can spawn agents)
  am token [--reset]          print (or regenerate) the API bearer token

remote (agents running on a server, am on your laptop):
  am -H <host> <command...>   run any am command on <host> over ssh
                              (bare \`am -H box\` opens the full hub UI remotely)
  export AM_HOST=<host>       make every am command remote by default;
                              -L / --local forces a one-off local run
  am ls [--local-only]        merged fleet across config.remotes hosts
  am move <name> <host>       move an agent to <host>: conversation + queue
  am move <host>:<name>       ...or pull one back from <host>
                              (--dir overrides the $HOME-mapped target dir,
                               --copy keeps the source, --no-start skips
                               auto-resume; uncommitted changes never travel)
  am clone <name> <host>      like move, but the source keeps running — the
                              conversation forks into two independent agents
  am tunnel <server> [--port n] [--ssh-port p]
                              (run on a roaming host) keep a reverse SSH tunnel
                              open so <server> can reach back to this host's sshd
                              — then add it to the server's config.remotes and
                              the fleet works both ways (see docs/reverse-ssh.md)
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["m", "message", "dir", "worktree", "model", "effort", "to", "out", "host", "H", "port", "bind", "from", "report-to", "file", "timeout", "ssh-port"]);
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

// `am send <name> -` reads the body from stdin, sidestepping the shell quoting
// (backticks, quotes) that mangles messages passed as arguments — and composes
// with pipes: `am transcript x | am send y -`.
async function resolveMessage(args: ParsedArgs): Promise<string> {
  const message = messageFrom(args);
  if (message !== "-") return message;
  const body = (await Bun.stdin.text()).replace(/\s+$/, "");
  if (!body) throw new Error("no message on stdin");
  return body;
}

// Agent-targeting commands resolve across the whole fleet: an explicit
// host:name always routes to that host, and a prefix that matches nothing
// local but exactly one remote agent forwards there transparently — so
// `am send demo "..."` works no matter which machine demo lives on.
const AGENT_COMMANDS = new Set([
  "j", "jump", "send", "interrupt", "int", "queue", "q", "stop", "rm", "resume", "transcript", "handoff", "cd",
  "report", "comms",
]);

// Attributed sends keep their sender across an ssh hop: AGENTMGR_AGENT doesn't
// survive ssh, so inject `--from <sender>` (host-qualified when this machine
// knows its own alias) into the forwarded argv. Local resolution leaves
// non-send commands and already-explicit --from untouched.
function injectSender(command: string | undefined, argv: string[]): string[] {
  if (command !== "send" && command !== "interrupt" && command !== "int") return argv;
  if (argv.includes("--from")) return argv;
  const sender = resolveSender();
  if (!sender) return argv;
  // Always host-qualify so the recipient sees a reply-able `host:name` (matching
  // the outbox path). hostAlias when set, else this machine's short hostname.
  const alias = loadConfig().hostAlias || shortHost(hostname());
  return [...argv, "--from", `${alias}:${sender}`];
}

function maybeForwardToFleet(command: string | undefined, args: ParsedArgs, argv: string[]): void {
  if (!command || !AGENT_COMMANDS.has(command)) return;
  // A file send routes itself: the file is local, so it scp's the bytes and
  // forwards only the note — not the whole command (the path wouldn't exist on
  // the far side).
  if (command === "send" && args.flags.file) return;
  const ref = args.positional[0];
  if (!ref) return;

  // Shared resolver (route.ts): only a "remote" target forwards over ssh;
  // local/none fall through to local dispatch (which handles the outbox for
  // unreachable targets).
  const target = resolveTarget(ref);
  if (target.kind === "remote") {
    remoteExec(target.host, injectSender(command, argv.map((a) => (a === ref ? target.name : a))));
  }
}

async function pickerFlow(): Promise<void> {
  const load = fleetPickerItems;
  const handlers: PickerHandlers = {
    stop: (key: string) => {
      const { host, name } = splitFleetKey(key);
      if (host) {
        const result = sshAm(host, ["stop", name]);
        if (result.exitCode !== 0) return { text: `stop failed: ${result.stderr.trim()}`, level: "error" };
        return `stopped ${name} on ${host}`;
      }
      const agent = readAgent(name);
      if (agent) stopAgent(agent);
      return `stopped ${name} (resume with \`am resume ${name}\`)`;
    },
    remove: (key: string) => {
      const { host, name } = splitFleetKey(key);
      if (host) {
        const result = sshAm(host, ["rm", name]);
        if (result.exitCode !== 0) return { text: `rm failed: ${result.stderr.trim()}`, level: "error" };
        return `removed ${name} on ${host}`;
      }
      const agent = readAgent(name);
      if (agent) destroyAgent(agent, { clean: false });
      return `removed ${name}`;
    },
    preview: (key: string) => {
      const { host, name } = splitFleetKey(key);
      if (host) {
        if (!name) return [`(${host} unreachable)`];
        return cachedRemotePreview(host, name) ?? [`(fetching ${name}@${shortHost(host)}…)`];
      }
      const agent = readAgent(name);
      if (!agent) return [];
      const live = capturePane(agent.tmuxSession, { colors: true });
      if (live) return live;
      const snapshot = readSnapshot(name);
      if (snapshot) return [`(last screen — ${displayStatus(agent)})`, ...snapshot];
      return [`(no live session — ${displayStatus(agent)})`];
    },
    create: async (
      name: string,
      task: string | undefined,
      dir: string | undefined,
      _host: string | undefined,
      provider: string | undefined,
      model: string | undefined,
      effort: string | undefined,
    ) => {
      await newCommand({
        name,
        message: task,
        dir: dir ? expandHome(dir) : undefined,
        provider: provider as Provider | undefined,
        model,
        effort,
        jump: false,
        quiet: true,
      });
      return name;
    },
    // Dir prompt prefill: the highlighted agent's dir (related work usually
    // lives in the same project), else where `am` was launched from.
    defaultDir: (highlighted: string | null) => {
      const { host, name } = highlighted ? splitFleetKey(highlighted) : { host: undefined, name: "" };
      const agent = !host && name ? readAgent(name) : null;
      return shortenHome(agent?.dir ?? process.cwd());
    },
    move: moveHandler,
    clone: cloneHandler,
    handoff: handoffHandler,
    regroup: () => `grouped by ${toggleGroupMode() === "dir" ? "directory" : "host"}`,
    cd: cdHandler,
    cdPrefill: (key: string) => {
      const { host, name } = splitFleetKey(key);
      if (host) return name ? (cachedRemoteRow(host, name)?.dir ?? "") : "";
      return readAgent(name)?.dir ?? "";
    },

  };

  // Hub loop: attach blocks until the user detaches (ctrl-q inside an agent),
  // then the picker reopens on the agent they just left. Inside tmux,
  // switch-client returns immediately, so jump once and exit instead.
  let cameFrom: string | undefined;
  while (true) {
    const chosen = await pick(load, handlers, cameFrom);
    if (!chosen) break;
    const { host, name } = splitFleetKey(chosen);
    if (host) {
      if (!name) continue; // unreachable-host placeholder row
      // Revive dead remote agents, then attach over ssh until detach.
      const row = cachedRemoteRow(host, name);
      if (row && (row.status === "exited" || row.status === "dead")) sshAm(host, ["resume", name]);
      sshAmInteractive(host, ["j", name]);
    } else {
      // Picking an exited/dead agent revives it before jumping in.
      const picked = readAgent(name);
      if (picked && !hasSession(picked.tmuxSession)) await reviveAgent(picked);
      jumpCommand(name);
      if (insideTmux()) break;
    }
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
  maybeForwardToFleet(command, args, localArgv);

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
        model: args.flags.model as string | undefined,
        effort: args.flags.effort as string | undefined,
        resume: args.flags.resume as string | boolean | undefined,
        continue: !!args.flags.continue,
        jump: args.flags["no-jump"] ? false : undefined,
        remote: args.flags.remote ? true : args.flags["no-remote"] ? false : undefined,
        inPlace: !!args.flags["in-place"],
        reportTo: args.flags["report-to"] as string | undefined,
        report: !!args.flags.report,
        mcp: args.flags["no-mcp"] ? false : undefined,
      });
      break;
    case "run": {
      const runName = requirePositional(args, 0, "agent name");
      const runMessage = (args.flags.m ?? args.flags.message) as string | undefined;
      if (!runMessage) throw new Error("am run requires a task: -m \"<task>\"");
      await runCommand(runName, {
        message: runMessage,
        dir: args.flags.dir as string | undefined,
        worktree: args.flags.worktree as string | undefined,
        provider: args.flags.codex ? "codex" : undefined,
        model: args.flags.model as string | undefined,
        effort: args.flags.effort as string | undefined,
        timeoutSec: args.flags.timeout ? Number(args.flags.timeout) : undefined,
        rm: !!args.flags.rm,
        json: !!args.flags.json,
      });
      break;
    }
    case "resume":
      await resumeCommand(requirePositional(args, 0, "agent name"), {
        message: (args.flags.m ?? args.flags.message) as string | undefined,
        remote: args.flags.remote ? true : args.flags["no-remote"] ? false : undefined,
      });
      break;
    case "ls":
    case "list":
      lsCommand({ json: !!args.flags.json, localOnly: !!args.flags["local-only"] });
      break;
    case "j":
    case "jump":
      jumpCommand(requirePositional(args, 0, "agent name"));
      break;
    case "-":
      jumpPreviousCommand();
      break;
    case "send":
      if (args.flags.file) {
        await sendFileCommand(requirePositional(args, 0, "agent name"), args.flags.file as string, {
          message: args.positional.slice(1).join(" ") || undefined,
          now: !!args.flags.now,
          from: args.flags.from as string | undefined,
        });
      } else {
        await sendCommand(requirePositional(args, 0, "agent name"), await resolveMessage(args), {
          now: !!args.flags.now,
          from: args.flags.from as string | undefined,
        });
      }
      break;
    case "interrupt":
    case "int":
      await interruptCommand(requirePositional(args, 0, "agent name"), messageFrom(args), {
        from: args.flags.from as string | undefined,
      });
      break;
    case "report":
      reportCommand(requirePositional(args, 0, "agent name"), {
        to: args.flags.to as string | undefined,
        clear: !!args.flags.clear,
      });
      break;
    case "comms":
      commsCommand(requirePositional(args, 0, "agent name"));
      break;
    case "outbox":
      outboxCommand({ clear: !!args.flags.clear });
      break;
    case "__outbox-take":
      outboxTakeCommand(args.positional);
      break;
    case "__outbox-claim":
      outboxClaimCommand(requirePositional(args, 0, "claim id"), args.positional.slice(1));
      break;
    case "__outbox-ack":
      outboxAckCommand(requirePositional(args, 0, "claim id"));
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
    case "cd":
      await cdCommand(requirePositional(args, 0, "agent name"), requirePositional(args, 1, "directory"), {
        inPlace: !!args.flags["in-place"],
        start: !args.flags["no-start"],
      });
      break;
    case "move":
    case "clone":
      await moveCommand(requirePositional(args, 0, "agent (or host:agent)"), args.positional[1], {
        dir: args.flags.dir as string | undefined,
        copy: !!args.flags.copy,
        start: !args.flags["no-start"],
        clone: command === "clone",
      });
      break;
    case "__export":
      exportCommand(requirePositional(args, 0, "agent name"));
      break;
    case "__import":
      await importCommand();
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
    case "restore":
      await restoreCommand(args.positional[0], { resume: args.flags["no-resume"] ? false : undefined });
      break;
    case "hook":
      await hookCommand(requirePositional(args, 0, "hook event"));
      break;
    case "daemon":
      await daemonCommand(args.positional[0]);
      break;
    case "serve":
      serveCommand({
        port: args.flags.port ? Number(args.flags.port) : undefined,
        bind: args.flags.bind as string | undefined,
      });
      return; // keep the process alive serving HTTP
    case "token":
      tokenCommand({ reset: !!args.flags.reset });
      break;
    case "watch":
      await watchCommand();
      break;
    case "tunnel":
      await runTunnel(requirePositional(args, 0, "server host"), {
        port: args.flags.port ? Number(args.flags.port) : undefined,
        sshPort: args.flags["ssh-port"] ? Number(args.flags["ssh-port"]) : undefined,
      });
      return; // long-runner — supervises the reverse tunnel until killed
    case "mcp":
      await runMcpServer();
      return; // long-runner — speaks MCP over stdio until the client disconnects
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
