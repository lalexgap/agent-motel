import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome, inboxDir } from "../paths";
import { matchAgent, resolveAgent } from "../state";
import { loadConfig } from "../config";
import { fleetRows, splitFleetKey } from "../fleet";
import { runAsync, sshAmAsync, sshRunAsync } from "../remote";
import { shQuote } from "../tmux";
import { resolveSender } from "../comms";
import { remoteHome } from "./move";
import { sendCommand } from "./send";

// `am send <name> --file <path>`: hand a file to another agent. The bytes are
// copied into the recipient's inbox (locally, or over scp for a remote agent),
// then the agent gets an attributed note pointing at where it landed. Built on
// the same scp/ssh primitives as `am move`.

export interface SendFileOpts {
  message?: string;
  from?: string;
  now?: boolean;
}

// The note the recipient sees (before attribution wraps it). Pure for testing.
export function fileNote(message: string | undefined, destPath: string): string {
  const lead = message?.trim() ? message.trim() : "sent you a file";
  return `${lead} → ${destPath}`;
}

interface FileTarget {
  host?: string; // undefined = local
  name: string;
}

// Resolve which machine the recipient lives on — mirrors the fleet routing in
// index.ts, but here we must know the host to scp to it rather than forward the
// whole command (the file is local).
export function resolveFileTarget(ref: string): FileTarget {
  const { host, name } = splitFleetKey(ref);
  if (host && name) {
    const known = loadConfig().remotes ?? [];
    if (!known.includes(host)) throw new Error(`unknown host "${host}" — not in config.remotes`);
    return { host, name };
  }
  const local = matchAgent(ref);
  if (local) return { name: local.name };

  const remoteRows = fleetRows({ timeoutMs: 4000 }).rows.filter((r) => r.host);
  const exact = remoteRows.filter((r) => r.name === ref || r.aliases?.includes(ref));
  const prefix = remoteRows.filter((r) => r.name.startsWith(ref));
  if (exact.length > 1) {
    throw new Error(`"${ref}" is ambiguous across hosts: ${exact.map((r) => `${r.host}:${r.name}`).join(", ")}`);
  }
  const match = exact.length === 1 ? exact[0] : prefix.length === 1 ? prefix[0] : null;
  if (match?.host) return { host: match.host, name: match.name };
  if (prefix.length > 1) {
    throw new Error(`"${ref}" is ambiguous across hosts: ${prefix.map((r) => `${r.host}:${r.name}`).join(", ")}`);
  }
  throw new Error(`no agent matches "${ref}"`);
}

// host-qualify the sender for a cross-host note, so the recipient can reply —
// same rule as the ssh-forwarding injectSender in index.ts.
function qualifiedSender(from: string): string {
  const alias = loadConfig().hostAlias;
  return alias ? `${alias}:${from}` : from;
}

export async function sendFileCommand(ref: string, filePath: string, opts: SendFileOpts): Promise<void> {
  const src = resolve(expandHome(filePath));
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new Error(`not a file: ${src}`);
  }
  const fileName = basename(src);
  const from = resolveSender(opts.from);
  const target = resolveFileTarget(ref);

  if (!target.host) {
    // Local recipient: copy into its inbox, then deliver the note through the
    // normal send path (attribution + rate limiting included).
    const agent = resolveAgent(target.name);
    const dest = join(inboxDir(agent.name), fileName);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`copied ${fileName} → ${dest}`);
    await sendCommand(agent.name, fileNote(opts.message, dest), { now: !!opts.now, from });
    return;
  }

  // Remote recipient: scp into its inbox on that host, then forward the note
  // over ssh so the far-side `am send` attributes and delivers it.
  const home = await remoteHome(target.host);
  const destDir = `${home}/.agent-manager/inbox/${target.name}`;
  const dest = `${destDir}/${fileName}`;
  const mkdir = await sshRunAsync(target.host, `mkdir -p ${shQuote(destDir)}`, { timeoutMs: 8000 });
  if (mkdir.exitCode !== 0) throw new Error(`could not create inbox on ${target.host}: ${mkdir.stderr.trim()}`);
  const scp = await runAsync(["scp", "-q", src, `${target.host}:${shQuote(dest)}`], { timeoutMs: 120000 });
  if (scp.exitCode !== 0) throw new Error(`file copy to ${target.host} failed: ${scp.stderr.trim()}`);
  console.log(`copied ${fileName} → ${target.host}:${dest}`);

  const noteArgs = ["send", target.name, fileNote(opts.message, dest)];
  if (opts.now) noteArgs.push("--now");
  if (from) noteArgs.push("--from", qualifiedSender(from));
  const sent = await sshAmAsync(target.host, noteArgs, { timeoutMs: 15000 });
  if (sent.exitCode !== 0) {
    console.error(`file delivered, but notifying ${target.name} failed: ${(sent.stderr + sent.stdout).trim()}`);
    return;
  }
  process.stdout.write(sent.stdout);
}
