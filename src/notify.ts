import { loadConfig, type Config } from "./config";

// Desktop/push notifications, portable across the laptop (macOS) and a
// headless server (linux). Resolution order:
//   1. config.notifyCommand — any platform; run via sh with $AM_TITLE and
//      $AM_MESSAGE (e.g. a curl to ntfy.sh for phone push from a server)
//   2. macOS: terminal-notifier as config.notifySender (terminal icon, click
//      focuses it), else osascript (Script Editor icon)
//   3. linux: notify-send when present
//   4. silently nothing — a missing notifier must never matter

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
    if (config.notifySender && env.has("terminal-notifier")) {
      return ["terminal-notifier", "-title", title, "-message", message, "-sender", config.notifySender, "-group", `am-${title}`];
    }
    const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return ["osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`];
  }
  if (env.has("notify-send")) return ["notify-send", title, message];
  return null;
}

export function notify(title: string, message: string): void {
  const cmd = buildNotifyCommand(title, message, loadConfig(), {
    platform: process.platform,
    has: (binary) => !!Bun.which(binary),
  });
  if (!cmd) return;
  // Fire-and-forget: hooks run these, and a notifier that blocks
  // (terminal-notifier is known to linger) must never stall a hook.
  Bun.spawn({
    cmd,
    env: { ...process.env, AM_TITLE: title, AM_MESSAGE: message },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}
