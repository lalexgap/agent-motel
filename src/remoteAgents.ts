import { homedir } from "node:os";
import { loadConfig, localHostIdentity } from "./config";
import { sshAmAsync, sshRunAsync, type SshResult } from "./remote";
import { mapHomeDir, remoteHome } from "./commands/move";

// `am serve` driving agents on other fleet hosts: each API call runs the
// matching am CLI on that host over the same ssh transport `am -H` uses.

// Same rule as `am new`; hosts are ssh aliases / dns names.
export const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
export const HOST_RE = /^[a-zA-Z0-9_.-]+$/;

export const REMOTE_TIMEOUT_MS = 20_000;
export const REMOTE_NEW_TIMEOUT_MS = 90_000;

export class RemoteError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type AmRunner = (host: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<SshResult>;
type ShRunner = (host: string, command: string, opts?: { timeoutMs?: number }) => Promise<SshResult>;

let amRunner: AmRunner = sshAmAsync;
let shRunner: ShRunner = sshRunAsync;

export function setRemoteRunnersForTests(runners: { am?: AmRunner; sh?: ShRunner } = {}): void {
  amRunner = runners.am ?? sshAmAsync;
  shRunner = runners.sh ?? sshRunAsync;
}

// null = this machine; a string = a configured remote; undefined = unknown.
export function resolveHost(host: string): string | null | undefined {
  if (host === "local" || host === localHostIdentity()) return null;
  return (loadConfig().remotes ?? []).includes(host) ? host : undefined;
}

// Run `am <args>` on host and return stdout. `--local` keeps the remote am
// from forwarding a name it doesn't have to yet another fleet host.
export async function runRemoteAm(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS;
  let result: SshResult;
  try {
    result = await amRunner(host, [...args, "--local"], { stdin: opts.stdin, timeoutMs });
  } catch (error) {
    throw new RemoteError(`ssh ${host}: ${(error as Error).message}`, 502);
  }
  if (result.exitCode === 0) return result.stdout;
  const stderr = result.stderr.trim().replace(/^am: /, "");
  if (result.exitCode === 124) throw new RemoteError(`ssh ${host}: timed out after ${timeoutMs / 1000}s`, 502);
  if (result.exitCode === 255) throw new RemoteError(`ssh ${host}: ${stderr || "connection failed"}`, 502);
  if (result.exitCode === 127) throw new RemoteError(`am not found on ${host}: ${stderr}`, 502);
  if (/unknown command/.test(stderr)) throw new RemoteError(`remote am too old on ${host} (${stderr})`, 409);
  if (/no agent matches|no agents exist|no local agent/.test(stderr)) throw new RemoteError(stderr, 404);
  throw new RemoteError(stderr || `am ${args[0]} failed on ${host} (exit ${result.exitCode})`, 409);
}

export async function runRemoteJson<T>(host: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<T> {
  const stdout = await runRemoteAm(host, args, opts);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new RemoteError(`remote am too old on ${host} (\`am ${args.join(" ")}\` did not print JSON)`, 409);
  }
}

// The dir a remote `am new` should use: an explicit remoteDir wins, else a
// path under this machine's $HOME maps onto the remote $HOME (as `am move`).
export async function remoteSpawnDir(
  host: string,
  dir: string | undefined,
  remoteDir: string | undefined,
): Promise<string | undefined> {
  if (remoteDir) return remoteDir;
  if (!dir) return undefined;
  const localHome = homedir();
  if (mapHomeDir(dir, localHome, localHome) === null) {
    throw new RemoteError(`dir ${dir} is not under ${localHome} — pass remoteDir for ${host}`, 400);
  }
  let targetHome: string;
  try {
    targetHome = await remoteHome(host, shRunner);
  } catch (error) {
    throw new RemoteError((error as Error).message, 502);
  }
  return mapHomeDir(dir, localHome, targetHome)!;
}
