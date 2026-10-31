import { homedir } from "node:os";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shQuote } from "./tmux";
import { recordAudit } from "./audit";
import { parseArgs, selectedProvider } from "./args";
import { parseCatalogs } from "./catalog";

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

const ANTIGRAVITY_PROBE = ["models", "--json", "--antigravity", "--local"];

export function needsAntigravitySupport(args: string[]): boolean {
  if (!args.some(arg => ["--provider", "--antigravity", "--codex", "--claude"].includes(arg))) return false;
  const provider = selectedProvider(parseArgs(args.slice(1)).flags);
  return provider === "antigravity" && args[0] !== "models";
}

export function assertAntigravitySupport(host: string, result: SshResult): void {
  const catalog = result.exitCode === 0 ? parseCatalogs(result.stdout).find(c => c.provider === "antigravity") : undefined;
  if (!catalog?.modelsExhaustive || !catalog.models.length || !catalog.models.every(m => /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(m.id))) {
    throw new Error(`antigravity support could not be verified on ${host}; update remote am and check agy models`);
  }
}

function createdName(args: string[]): string | undefined {
  if (args[0] !== "new" && args[0] !== "run") return undefined;
  const { positional, flags } = parseArgs(args.slice(1));
  return flags.rm ? undefined : positional[0];
}

function assertCreatedProvider(host: string, name: string, result: SshResult): void {
  let detail: { provider?: unknown } | undefined;
  try { detail = JSON.parse(result.stdout); } catch {}
  if (result.exitCode !== 0 || detail?.provider !== "antigravity") {
    throw new Error(`remote ${host}:${name} did not confirm provider antigravity; inspect it before retrying`);
  }
}

// Injected transports use the same negotiation as the real SSH path. Old am
// ignores unknown flags, so a successful exit alone cannot establish support.
export async function checkedRemoteAm(
  host: string, args: string[],
  opts: { stdin?: string; timeoutMs?: number },
  run: (host: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<SshResult>,
): Promise<SshResult> {
  const check = needsAntigravitySupport(args);
  if (check) assertAntigravitySupport(host, await run(host, ANTIGRAVITY_PROBE, { timeoutMs: 10000 }));
  const result = await run(host, args, opts);
  const name = check && result.exitCode === 0 ? createdName(args) : undefined;
  if (name) assertCreatedProvider(host, name, await run(host, ["__detail", name, "--local", "--exact"], { timeoutMs: 10000 }));
  return result;
}

function checkRemoteAmSync(host: string, args: string[]): boolean {
  const check = needsAntigravitySupport(args);
  if (check) assertAntigravitySupport(host, sshAm(host, ANTIGRAVITY_PROBE, { timeoutMs: 10000 }));
  return check;
}

function verifyRemoteAmSync(host: string, args: string[], check: boolean, exitCode: number): void {
  const name = check && exitCode === 0 ? createdName(args) : undefined;
  if (name) assertCreatedProvider(host, name, sshAm(host, ["__detail", name, "--local", "--exact"], { timeoutMs: 10000 }));
}

function auditForward(host: string, args: string[]): ((exitCode?: number, stdout?: string) => void) | undefined {
  const command = args[0];
  if (command !== "stop" && command !== "rm" && command !== "restart") return;
  const { positional, flags } = parseArgs(args.slice(1));
  const action = command === "stop" ? (flags["for-move"] === true ? "move" : "stop")
    : command === "rm" ? (flags["for-move"] === true ? "move-cleanup" : "remove") : "restart";
  const target = positional[0];
  if (!target) return;
  const requestId = recordAudit(target, action, "requested", { targetHost: host });
  return (exitCode, stdout) => {
    let refusalReason: string | undefined;
    if (exitCode === 0 && flags["if-idle"] === true && stdout !== undefined) {
      try {
        const result = JSON.parse(stdout);
        if (result?.ok === false) {
          refusalReason = ["busy", "queued", "in_turn"].includes(result.reason) ? result.reason : "remote_refused";
        }
      } catch {}
    }
    if (refusalReason) {
      recordAudit(target, action, "refused", { requestId, targetHost: host, reason: refusalReason });
      return;
    }
    recordAudit(target, action, exitCode === 0 ? "completed" : "failed", {
      requestId, targetHost: host,
      ...(exitCode === 0 ? {} : { reason: exitCode === undefined ? "ssh_spawn_failed" : exitCode === 124 ? "ssh_timeout" : "ssh_exit_nonzero" }),
    });
  };
}

function auditedForward<T>(host: string, args: string[], run: () => T, outcome: (result: T) => { exitCode: number; stdout?: string }): T {
  const finish = auditForward(host, args);
  try {
    const result = run();
    const { exitCode, stdout } = outcome(result);
    finish?.(exitCode, stdout);
    return result;
  } catch (error) {
    finish?.();
    throw error;
  }
}

// Login shell (bash -lc) so ~/.bun/bin lands on PATH for non-interactive
// ssh; bash rather than sh because profiles routinely use bashisms
// (`source`) that dash chokes on. argv is re-quoted to survive both ssh's
// argument join and the remote shell.
function sshArgv(host: string, remoteCommand: string, tty: boolean): string[] {
  return ["ssh", ...muxOpts(), ...(tty ? ["-t"] : []), host, "--", `bash -lc ${shQuote(remoteCommand)}`];
}

export function amCommandString(args: string[]): string {
  return ["am", ...args].map(shQuote).join(" ");
}

// An interactive `am <args>` on the host as one shell command string, for a
// tmux pane to run (the hub's subagent view): the same login-shell + mux +
// tty setup as sshAmInteractive, so `am` resolves on the remote's PATH.
export function sshAmTtyCommand(host: string, args: string[]): string {
  return sshArgv(host, amCommandString(args), true).map(shQuote).join(" ");
}

// argv for a long-lived streaming `am <args>` on the host (the `__events`
// subscription) — the same login-shell + mux setup as sshAm, exposed so the
// caller can own the child process itself (liveness kills, reconnects). The
// mux options include ServerAliveInterval/CountMax, so ssh notices a dead
// TCP path in ~45s on its own; the caller's liveness timer is a backstop.
export function sshAmStreamArgv(host: string, args: string[]): string[] {
  return sshArgv(host, amCommandString(args), false);
}

// Run `am <args>` on a remote host, capturing output. stdin (if given) is
// piped to the remote command — used by `am move` to stream import payloads.
export function sshAm(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): SshResult {
  const check = checkRemoteAmSync(host, args);
  const result = auditedForward(host, args, () => {
    const result = Bun.spawnSync(sshArgv(host, amCommandString(args), false), {
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      timeout: opts.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }, result => result);
  verifyRemoteAmSync(host, args, check, result.exitCode);
  return result;
}

// A killed-on-timeout process reports 124, like coreutils `timeout`.
function killAfter(proc: { kill: () => void }, timeoutMs?: number) {
  const state = { timedOut: false };
  const timer = timeoutMs
    ? setTimeout(() => {
        state.timedOut = true;
        proc.kill();
      }, timeoutMs)
    : undefined;
  return { state, settle: () => clearTimeout(timer) };
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
  const timeout = killAfter(proc, opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  timeout.settle();
  return { exitCode: timeout.state.timedOut ? 124 : exitCode, stdout, stderr };
}

// File transfer, deliberately not scp. Since OpenSSH 9.0 scp speaks the SFTP
// protocol, where the remote path is handed to the far side verbatim instead of
// to a shell — so a shell-quoted path is looked up with its quotes attached
// ("scp: '/home/…/theme.png': No such file or directory"), while an unquoted one
// splits on spaces under the older scp protocol. `cat` over ssh always goes
// through the remote shell, so shQuote is correct on every OpenSSH; it also
// rides the multiplexed connection (scp opens its own), and mtimes here are
// stamped from the manifest rather than copied, so scp -p buys nothing.

// Pull a remote file, writing it to destPath only once the whole byte stream
// arrives — a truncated pull must never masquerade as a cached artifact.
export async function sshPullFile(
  host: string,
  remotePath: string,
  destPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<SshResult> {
  const partial = `${destPath}.part`;
  // Bytes land in the file directly: piping them through a Response never
  // settles under Bun, and a string round-trip would corrupt binaries.
  const proc = Bun.spawn(["ssh", ...muxOpts(), host, "--", `cat -- ${shQuote(remotePath)}`], {
    stdin: "ignore",
    stdout: Bun.file(partial),
    stderr: "pipe",
  });
  const timeout = killAfter(proc, opts.timeoutMs);
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  timeout.settle();
  const code = timeout.state.timedOut ? 124 : exitCode;
  if (code === 0) {
    renameSync(partial, destPath);
  } else {
    rmSync(partial, { force: true });
  }
  return { exitCode: code, stdout: "", stderr };
}

// Push a local file to an absolute remote path (its directory must exist).
export async function sshPushFile(
  host: string,
  srcPath: string,
  remotePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<SshResult> {
  const proc = Bun.spawn(["ssh", ...muxOpts(), host, "--", `cat > ${shQuote(remotePath)}`], {
    stdin: Bun.file(srcPath),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = killAfter(proc, opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  timeout.settle();
  return { exitCode: timeout.state.timedOut ? 124 : exitCode, stdout, stderr };
}

// Same as sshAm, asynchronously — for the picker's background fleet refresh
// and the move pipeline.
export async function sshAmAsync(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<SshResult> {
  const finish = auditForward(host, args);
  try {
    const result = await checkedRemoteAm(host, args, opts, (target, command, options) => runAsync(sshArgv(target, amCommandString(command), false), options));
    finish?.(result.exitCode, result.stdout);
    return result;
  } catch (error) {
    finish?.();
    throw error;
  }
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
  const check = checkRemoteAmSync(host, args);
  const code = auditedForward(host, args, () => {
    const result = Bun.spawnSync(sshArgv(host, amCommandString(args), true), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return result.exitCode;
  }, code => ({ exitCode: code }));
  verifyRemoteAmSync(host, args, check, code);
  return code;
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
  const args = stripHostArgs(argv);
  const check = checkRemoteAmSync(host, args);
  const result = auditedForward(host, args, () => Bun.spawnSync(sshArgv(host, amCommandString(args), interactive), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }), result => ({ exitCode: result.exitCode }));
  verifyRemoteAmSync(host, args, check, result.exitCode);
  process.exit(result.exitCode);
}
