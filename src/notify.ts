import { closeSync, constants, openSync, readFileSync, writeSync } from "node:fs";
import { loadConfig, localHostIdentity, type Config } from "./config";
import { tmux } from "./tmux";
import { notificationPrUrl, recordNotification, type NotificationKind } from "./notifications";

function terminalNotifierValue(value: string): string {
  if (value.startsWith("-")) return ` ${value}`;
  return /^[\[({"]/.test(value) ? `\\${value}` : value;
}

// Desktop/push notifications, portable across the laptop (macOS) and a
// headless server (linux). Resolution order:
//   1. config.notifyCommand — any platform; run via sh with $AM_TITLE and
//      $AM_MESSAGE (e.g. a curl to ntfy.sh for phone push from a server)
//   2. macOS: the Agent Motel app when it is running (its own banners, click
//      to open the agent); else clickable PRs use terminal-notifier, other
//      alerts/failures iTerm2 when attached, then osascript (Script Editor icon)
//   3. linux: notify-send when present
//   4. silently nothing — a missing notifier must never matter
// Every notification is also journaled so remote daemons can relay it.

export const APP_BUNDLE_ID = "ca.alexgap.agent-motel";
export const APP_PROCESS = "AgentMotel";
const APP_TITLE_MAX = 200;
const APP_MESSAGE_MAX = 1000;

// Who and what a notification is about, for the app's grouping, preferences
// and click-through. Absent for summaries and legacy callers.
export interface NotificationMeta {
  id?: string;
  host?: string;
  agent?: string;
  kind?: NotificationKind;
}

// The app's hand-off URL. The app validates every field again; this only
// bounds the size and drops what the app would reject anyway.
export function appNotificationUrl(title: string, message: string, url: string | undefined, meta: NotificationMeta = {}): string {
  const fields: [string, string][] = [["v", "1"], ["title", title.slice(0, APP_TITLE_MAX)], ["message", message.slice(0, APP_MESSAGE_MAX)]];
  for (const key of ["id", "host", "agent", "kind"] as const) {
    const value = meta[key];
    if (value) fields.push([key, value]);
  }
  const target = notificationPrUrl(url);
  if (target) fields.push(["url", target]);
  // Percent-encoding, not URLSearchParams: Foundation reads "+" as a literal plus.
  return `agent-motel://notify?${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

// The running app's bundle, from its executable path (…/X.app/Contents/MacOS/AgentMotel).
export function appBundleFromExecutable(path: string): string | null {
  const match = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(path.trim());
  return match ? match[1]! : null;
}

// True when its Info.plist registers the hand-off scheme. An older build
// would take the URL and show nothing, so it must not get the hand-off.
export function plistDeclaresScheme(plist: string): boolean {
  return /<key>CFBundleURLSchemes<\/key>\s*<array>(?:(?!<\/array>)[^])*<string>agent-motel<\/string>/.test(plist);
}

function appHandoffReady(): boolean {
  const pids = Bun.spawnSync(["pgrep", "-x", APP_PROCESS], { stderr: "ignore" });
  if (pids.exitCode !== 0) return false;
  for (const pid of pids.stdout.toString().split("\n").filter(Boolean)) {
    const comm = Bun.spawnSync(["ps", "-o", "comm=", "-p", pid], { stderr: "ignore" });
    const bundle = appBundleFromExecutable(comm.stdout.toString());
    if (!bundle) continue;
    try {
      if (plistDeclaresScheme(readFileSync(`${bundle}/Contents/Info.plist`, "utf8"))) return true;
    } catch { /* not readable: treat as an old build */ }
  }
  return false;
}

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
    if (target && env.has("terminal-notifier")) return ["terminal-notifier", "-title", terminalNotifierValue(title), "-message", terminalNotifierValue(message), "-open", target];
    const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`];
  }
  if (env.has("notify-send")) return ["notify-send", title, message];
  return null;
}

export function notify(title: string, message: string, meta: { agent?: string; kind: NotificationKind; url?: string }): void {
  const url = notificationPrUrl(meta.url);
  const host = localHostIdentity();
  let id: string | undefined;
  try {
    id = recordNotification({ host, agent: meta.agent, kind: meta.kind, title, message, ...(url ? { url } : {}) }).id;
  } catch {
    // the journal is best-effort, like the notifier
  }
  showNotification(title, message, url, { id, host, agent: meta.agent, kind: meta.kind });
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
  run: (cmd: string[], vars: Record<string, string>, options?: { keepAlive?: boolean }) => Promise<number>;
  // Whether an Agent Motel app that accepts the hand-off is running on this Mac.
  appRunning: () => boolean;
  iterm: (title: string, message: string) => boolean;
  warn: (message: string) => void;
}

export async function deliverNotification(
  title: string,
  message: string,
  url: string | undefined,
  config: Config,
  delivery: NotificationDelivery,
  meta: NotificationMeta = {},
): Promise<void> {
  const target = notificationPrUrl(url);
  const vars = { AM_TITLE: title, AM_MESSAGE: message, AM_URL: target ?? "" };
  if (!config.notifyCommand && delivery.platform === "darwin") {
    // The running app shows it instead, so it's one banner from one sender;
    // the app applies its own per-kind preferences and quiet hours.
    if (config.appNotifications !== false && delivery.appRunning()) {
      try {
        const handoff = ["open", "-g", "-b", APP_BUNDLE_ID, appNotificationUrl(title, message, target, meta)];
        if (await delivery.run(handoff, vars, { keepAlive: true }) === 0) return;
      } catch { /* Fall back to the standard notifiers. */ }
      delivery.warn("am: could not hand the notification to the Agent Motel app; using the standard notifier.");
    }
    if (target && delivery.has("terminal-notifier")) {
      try {
        const cmd = buildNotifyCommand(title, message, config, delivery, target)!;
        if (await delivery.run(cmd, vars, { keepAlive: true }) === 0) return;
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
export function showNotification(title: string, message: string, url?: string, meta: NotificationMeta = {}): void {
  void deliverNotification(title, message, url, loadConfig(), {
    platform: process.platform,
    has: binary => !!Bun.which(binary),
    appRunning: appHandoffReady,
    iterm: postViaIterm,
    warn: message => console.error(message),
    run: async (cmd, vars, options) => {
      const child = Bun.spawn({ cmd, env: { ...process.env, ...vars }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      if (!options?.keepAlive) child.unref();
      const timeout = setTimeout(() => child.kill(), 10_000);
      if (!options?.keepAlive) timeout.unref();
      const killTimeout = options?.keepAlive ? setTimeout(() => child.kill(9), 10_500) : undefined;
      try { return await child.exited; }
      finally {
        clearTimeout(timeout);
        if (killTimeout) clearTimeout(killTimeout);
      }
    },
  }, meta).catch(error => console.error(`am: notification display failed: ${error}`));
}
