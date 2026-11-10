import { closeSync, constants, openSync, writeSync } from "node:fs";
import { loadConfig, localHostIdentity, type Config } from "./config";
import { tmux } from "./tmux";
import { notificationPrUrl, recordNotification, type NotificationKind } from "./notifications";

// Desktop/push notifications, portable across the laptop (macOS) and a
// headless server (linux). Resolution order:
//   1. config.notifyCommand — any platform; run via sh with $AM_TITLE and
//      $AM_MESSAGE (e.g. a curl to ntfy.sh for phone push from a server)
//   2. macOS: clickable PRs use terminal-notifier; other alerts/failures use
//      iTerm2 when attached, then osascript (Script Editor icon)
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
  url?: string,
): string[] | null {
  if (config.notifyCommand) return ["sh", "-c", config.notifyCommand];
  if (env.platform === "darwin") {
    const target = notificationPrUrl(url);
    if (target && env.has("terminal-notifier")) return ["terminal-notifier", "-title", title, "-message", message, "-open", target];
    const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`];
  }
  if (env.has("notify-send")) return ["notify-send", title, message];
  return null;
}

export function notify(title: string, message: string, meta: { agent?: string; kind: NotificationKind; url?: string }): void {
  const url = notificationPrUrl(meta.url);
  try {
    recordNotification({ host: localHostIdentity(), agent: meta.agent, kind: meta.kind, title, message, ...(url ? { url } : {}) });
  } catch {
    // the journal is best-effort, like the notifier
  }
  showNotification(title, message, url);
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

export interface NotificationDelivery extends NotifyEnv {
  run: (cmd: string[], vars: Record<string, string>) => Promise<number>;
  iterm: (title: string, message: string) => boolean;
  warn: (message: string) => void;
}

export async function deliverNotification(title: string, message: string, url: string | undefined, config: Config, delivery: NotificationDelivery): Promise<void> {
  const target = notificationPrUrl(url);
  const vars = { AM_TITLE: title, AM_MESSAGE: message, AM_URL: target ?? "" };
  if (!config.notifyCommand && delivery.platform === "darwin") {
    if (target && delivery.has("terminal-notifier")) {
      try {
        const cmd = buildNotifyCommand(title, message, config, delivery, target)!;
        if (await delivery.run(cmd, vars) === 0) return;
      } catch { /* Preserve the alert through the existing fallback. */ }
      delivery.warn("am: clickable PR notification failed; enable terminal-notifier in macOS Notifications. Using the standard notification fallback.");
    }
    if (config.itermNotifications !== false) {
      try { if (delivery.iterm(title, message)) return; } catch { /* A missing tmux binary must not lose the alert. */ }
    }
  }
  const cmd = buildNotifyCommand(title, message, config, delivery);
  if (cmd) await delivery.run(cmd, vars);
}

// Display without journaling, so relayed notifications don't bounce back.
export function showNotification(title: string, message: string, url?: string): void {
  void deliverNotification(title, message, url, loadConfig(), {
    platform: process.platform,
    has: binary => !!Bun.which(binary),
    iterm: postViaIterm,
    warn: message => console.error(message),
    run: async (cmd, vars) => {
      const child = Bun.spawn({ cmd, env: { ...process.env, ...vars }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      child.unref();
      const timeout = setTimeout(() => child.kill(), 10_000);
      timeout.unref();
      try { return await child.exited; }
      finally { clearTimeout(timeout); }
    },
  }).catch(error => console.error(`am: notification display failed: ${error}`));
}
