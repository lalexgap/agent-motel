import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, localHostIdentity } from "./config";
import { checkedRemoteAm, sshAmAsync, sshPushFile, sshRunAsync, type SshResult } from "./remote";
import { shQuote } from "./tmux";
import { mapHomeDir, remoteHome } from "./commands/move";
import { conflictReason, type ConflictReason } from "./messages";

// `am serve` driving agents on other fleet hosts: each API call runs the
// matching am CLI on that host over the same ssh transport `am -H` uses.

// Same rule as `am new`; hosts are ssh aliases / dns names.
export const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
export const HOST_RE = /^[a-zA-Z0-9_.-]+$/;

export const REMOTE_TIMEOUT_MS = 20_000;
export const REMOTE_NEW_TIMEOUT_MS = 90_000;

export class RemoteError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: ConflictReason) {
    super(message);
  }
}

type AmRunner = (host: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<SshResult>;
type ShRunner = (host: string, command: string, opts?: { timeoutMs?: number }) => Promise<SshResult>;
type PushRunner = (host: string, srcPath: string, remotePath: string, opts?: { timeoutMs?: number }) => Promise<SshResult>;

let amRunner: AmRunner = sshAmAsync;
let shRunner: ShRunner = sshRunAsync;
let pushRunner: PushRunner = sshPushFile;

export function setRemoteRunnersForTests(runners: { am?: AmRunner; sh?: ShRunner; push?: PushRunner } = {}): void {
  amRunner = runners.am ?? sshAmAsync;
  shRunner = runners.sh ?? sshRunAsync;
  pushRunner = runners.push ?? sshPushFile;
}

// null = this machine; a string = a configured remote; undefined = unknown.
export function resolveHost(host: string): string | null | undefined {
  if (host === "local" || host === localHostIdentity()) return null;
  return (loadConfig().remotes ?? []).includes(host) ? host : undefined;
}

// Run `am <args>` on host and return stdout. `--local` keeps the remote am
// from forwarding a name it doesn't have to yet another fleet host; `--exact`
// disables prefix matching, as the local routes do.
export async function runRemoteAm(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS;
  let result: SshResult;
  try {
    const forwarded = [...args, "--local", "--exact"];
    const options = { stdin: opts.stdin, timeoutMs };
    result = amRunner === sshAmAsync
      ? await amRunner(host, forwarded, options)
      : await checkedRemoteAm(host, forwarded, options, amRunner);
  } catch (error) {
    throw new RemoteError(`ssh ${host}: ${(error as Error).message}`, 502);
  }
  if (result.exitCode === 0) return result.stdout;
  const stderr = result.stderr.trim().replace(/^am: /, "");
  if (result.exitCode === 124) throw new RemoteError(`ssh ${host}: timed out after ${timeoutMs / 1000}s`, 502);
  if (result.exitCode === 255) throw new RemoteError(`ssh ${host}: ${stderr || "connection failed"}`, 502);
  if (result.exitCode === 127) throw new RemoteError(`am not found on ${host}: ${stderr}`, 502);
  if (/unknown command/.test(stderr)) throw new RemoteError(`remote am too old on ${host} (${stderr})`, 409, "remote_too_old");
  if (/no agent matches|no agents exist|no local agent|no message "|no permission request "/.test(stderr)) throw new RemoteError(stderr, 404);
  if (/unknown permission option|unknown (claude|codex|antigravity) (model|effort) "/.test(stderr)) throw new RemoteError(stderr, 400);
  throw new RemoteError(stderr || `am ${args[0]} failed on ${host} (exit ${result.exitCode})`, 409, conflictReason(stderr));
}

// An older remote am silently ignores --local/--exact and would prefix-match
// (or fleet-forward) the name, so before every agent operation prove that
// `__detail` (which ships with --exact) exists and finds this exact name.
// Not cached: the remote am can be rolled back under a long-lived serve.
export async function ensureExactCapable(host: string, name: string): Promise<void> {
  await runRemoteAm(host, ["__detail", name]);
}

export async function runRemoteJson<T>(
  host: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<T> {
  const stdout = await runRemoteAm(host, args, opts);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new RemoteError(`remote am too old on ${host} (\`am ${args.join(" ")}\` did not print JSON)`, 409, "remote_too_old");
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

// fileName must be server-generated: it is interpolated into a remote path.
export async function pushRemoteInboxFile(host: string, name: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const raw = await runRemoteAm(host, ["__detail", name]);
  let detail: { provider?: unknown; capabilities?: { attachments?: unknown } } | null = null;
  try { detail = JSON.parse(raw); } catch {}
  if (detail?.provider === "antigravity" || detail?.capabilities?.attachments === false) {
    throw new RemoteError("Antigravity image attachments are unsupported", 409);
  }
  let home: string;
  try {
    home = await remoteHome(host, shRunner);
  } catch (error) {
    throw new RemoteError((error as Error).message, 502);
  }
  const destDir = `${home}/.agent-manager/inbox/${name}`;
  const dest = `${destDir}/${fileName}`;
  // Create the file 0600 up front; the push's `cat >` keeps that mode.
  const mkdir = await shRunner(host, `mkdir -p ${shQuote(destDir)} && (umask 077 && : > ${shQuote(dest)})`, { timeoutMs: 8000 });
  if (mkdir.exitCode !== 0) throw new RemoteError(`could not create inbox on ${host}: ${mkdir.stderr.trim()}`, 502);
  const tmp = mkdtempSync(join(tmpdir(), "am-paste-"));
  try {
    const src = join(tmp, fileName);
    writeFileSync(src, bytes, { mode: 0o600 });
    const push = await pushRunner(host, src, dest, { timeoutMs: 120_000 });
    if (push.exitCode !== 0) throw new RemoteError(`file copy to ${host} failed: ${push.stderr.trim() || `exit ${push.exitCode}`}`, 502);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}
