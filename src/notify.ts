import { closeSync, constants, openSync, writeSync } from "node:fs";
import { loadConfig, localHostIdentity, type Config } from "./config";
import { tmux } from "./tmux";
import { recordNotification, type NotificationKind } from "./notifications";

// Desktop/push notifications, portable across the laptop (macOS) and a
// headless server (linux). Resolution order:
//   1. config.notifyCommand — any platform; run via sh with $AM_TITLE and
//      $AM_MESSAGE (e.g. a curl to ntfy.sh for phone push from a server)
//   2. macOS: iTerm2's own notification (OSC 9 to an attached iTerm2 tmux
//      client, for its icon), else osascript (Script Editor icon)
//   3. linux: notify-send when present
//   4. silently nothing — a missing notifier must never matter
// Every notification is also journaled so remote daemons can relay it.

export interface NotifyEnv {
  platform: NodeJS.Platform;
  has: (binary: string) => boolean;
}

export function buildNotifyCommand(
  title: string,
  message: string,
  config: Config,
  env: NotifyEnv,
): string[] | null {
  if (config.notifyCommand) return ["sh", "-c", config.notifyCommand];
  if (env.platform === "darwin") {
    const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`];
  }
  if (env.has("notify-send")) return ["notify-send", title, message];
  return null;
}

export function notify(title: string, message: string, meta: { agent?: string; kind: NotificationKind }): void {
  try {
    recordNotification({ host: localHostIdentity(), agent: meta.agent, kind: meta.kind, title, message });
  } catch {
    // the journal is best-effort, like the notifier
  }
  showNotification(title, message);
}

export function canShowNotifications(config: Config = loadConfig()): boolean {
  return buildNotifyCommand("", "", config, { platform: process.platform, has: (binary) => !!Bun.which(binary) }) !== null;
}

export interface TmuxClient {
  tty: string;
  termtype: string;
  activity: number;
  utf8: boolean;
  controlMode: boolean;
}

export function parseTmuxClients(stdout: string): TmuxClient[] {
  return stdout.split("\n").flatMap((line) => {
    const [tty, termtype, activity, utf8, controlMode] = line.split("\t");
    if (!tty?.startsWith("/dev/")) return [];
    return [{ tty, termtype: termtype ?? "", activity: Number(activity) || 0, utf8: utf8 === "1", controlMode: controlMode === "1" }];
  });
}

// The most recently active client running in iTerm2 — one, so several
// attached windows don't each post the same banner. Non-UTF-8 clients would
// read encoded bytes as C1 controls, and control-mode (tmux -CC) ttys carry
// the tmux protocol, so neither gets raw OSC.
export function pickItermClient(clients: TmuxClient[]): TmuxClient | null {
  const iterm = clients.filter((c) => c.termtype.startsWith("iTerm2") && c.utf8 && !c.controlMode);
  return iterm.reduce<TmuxClient | null>((best, c) => (!best || c.activity > best.activity ? c : best), null);
}

// OSC 9 carries a single line of text; strip control characters (C0, DEL,
// C1) so message content can't end the sequence early or inject another one.
export function osc9(title: string, message: string): string {
  const text = `${title}: ${message}`.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 500);
  return `\x1b]9;${text}\x07`;
}

// The tty is non-blocking, so a write can land short; treat that as failure.
export function writeOsc9(write: (data: Buffer) => number, title: string, message: string): boolean {
  const data = Buffer.from(osc9(title, message));
  return write(data) === data.length;
}

function postViaIterm(title: string, message: string): boolean {
  const listed = tmux("list-clients", "-F", "#{client_tty}\t#{client_termtype}\t#{client_activity}\t#{client_utf8}\t#{client_control_mode}");
  if (listed.exitCode !== 0) return false;
  const client = pickItermClient(parseTmuxClients(listed.stdout));
  if (!client) return false;
  let fd: number | undefined;
  try {
    // Non-blocking: a wedged terminal must never stall a hook or the daemon.
    fd = openSync(client.tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
    const tty = fd;
    return writeOsc9((data) => writeSync(tty, data), title, message);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Display without journaling, so relayed notifications don't bounce back.
export function showNotification(title: string, message: string): void {
  const config = loadConfig();
  if (!config.notifyCommand && process.platform === "darwin" && config.itermNotifications !== false && postViaIterm(title, message)) return;
  const cmd = buildNotifyCommand(title, message, config, {
    platform: process.platform,
    has: (binary) => !!Bun.which(binary),
  });
  if (!cmd) return;
  // Fire-and-forget: hooks run these, and a notifier that blocks must never
  // stall a hook.
  Bun.spawn({
    cmd,
    env: { ...process.env, AM_TITLE: title, AM_MESSAGE: message },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}
