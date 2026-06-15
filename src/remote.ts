import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shQuote } from "./tmux";

// `am -H server <cmd>` / `AM_HOST=server am <cmd>`: run the command on a
// remote am over plain SSH. am stays transport-ignorant — ssh does auth,
// encryption, and the terminal; this just forwards argv.

// Connection multiplexing: the daemon polls remotes on a tight cadence, and
// each plain ssh pays a full TCP+KEX+auth+login-shell handshake (~hundreds of ms
// + radio/battery on a laptop). ControlMaster reuses one persistent connection
// for every subsequent ssh to that host — polls drop to ~channel-open latency,
// shared automatically across the daemon and the TUI. Purely ssh-side, so am
// stays transport-ignorant; a stale master (laptop slept) is re-dialed
// transparently on the next call. Opt out with AM_SSH_NO_MUX=1.
let muxDirReady = false;
function muxOpts(): string[] {
  if (process.env.AM_SSH_NO_MUX) return [];
  const dir = join(homedir(), ".cache", "am", "ssh");
  if (!muxDirReady) {
    try {
      mkdirSync(dir, { recursive: true });
      muxDirReady = true;
    } catch {
      return []; // can't make the socket dir — fall back to plain ssh
    }
  }
  return [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(dir, "%C")}`,
    "-o", "ControlPersist=120",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];
}

export function stripHostArgs(argv: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--host" || arg === "-H") {
      i++; // skip the value too
      continue;
    }
    if (arg === "--local" || arg === "-L") continue;
    filtered.push(arg);
  }
  return filtered;
}

// Internal commands run on whatever machine fired them — forwarding a hook
// or click handler over SSH (e.g. via a profile-exported AM_HOST on the
// server itself) would loop or misfire.
export function isForwardable(command: string | undefined): boolean {
  return !command || (!command.startsWith("__") && command !== "hook");
}

export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Login shell (bash -lc) so profile PATH applies for non-interactive ssh; bash
// rather than sh because profiles routinely use bashisms (`source`) that dash
// chokes on. We also PREPEND the usual install dirs to PATH: a remote host whose
// `am`/`tmux` live only on its *zsh* PATH (common on macOS) wouldn't expose them
// to a bash login shell, so the fleet would see it as unreachable. Prepending is
// additive — the host's own profile PATH still applies and wins for anything not
// in these dirs. Non-existent dirs (e.g. Homebrew on Linux) are harmless.
const REMOTE_PATH_PREFIX =
  'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';

export function sshArgv(host: string, remoteCommand: string, tty: boolean): string[] {
  const wrapped = `bash -lc ${shQuote(REMOTE_PATH_PREFIX + remoteCommand)}`;
  return ["ssh", ...muxOpts(), ...(tty ? ["-t"] : []), host, "--", wrapped];
}

export function amCommandString(args: string[]): string {
  return ["am", ...args].map(shQuote).join(" ");
}

// Run `am <args>` on a remote host, capturing output. stdin (if given) is
// piped to the remote command — used by `am move` to stream import payloads.
export function sshAm(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): SshResult {
  const result = Bun.spawnSync(sshArgv(host, amCommandString(args), false), {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    timeout: opts.timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// Async process runner shared by the non-blocking ssh helpers: the move
// pipeline runs inside the sidebar's event loop, where a spawnSync would
// freeze rendering and input for the duration.
export async function runAsync(
  cmd: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<SshResult> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode: timedOut ? 124 : exitCode, stdout, stderr };
}

// Same as sshAm, asynchronously — for the picker's background fleet refresh
// and the move pipeline.
export async function sshAmAsync(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<SshResult> {
  return runAsync(sshArgv(host, amCommandString(args), false), opts);
}

// Async raw remote command (realpath, test -d, mkdir).
export async function sshRunAsync(
  host: string,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<SshResult> {
  return runAsync(["ssh", ...muxOpts(), host, "--", command], opts);
}

// Run `am <args>` remotely with the terminal attached (interactive jump from
// the picker). Returns when the remote command does — unlike remoteExec it
// does NOT exit the process.
export function sshAmInteractive(host: string, args: string[]): number {
  const result = Bun.spawnSync(sshArgv(host, amCommandString(args), true), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode;
}

// Run a raw (non-am) command on the host, e.g. tmux capture-pane or test -d.
export function sshRun(
  host: string,
  command: string,
  opts: { timeoutMs?: number } = {},
): SshResult {
  const result = Bun.spawnSync(["ssh", ...muxOpts(), host, "--", command], {
    stdin: "ignore",
    timeout: opts.timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function remoteExec(host: string, argv: string[]): never {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const result = Bun.spawnSync(sshArgv(host, amCommandString(stripHostArgs(argv)), interactive), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(result.exitCode);
}
