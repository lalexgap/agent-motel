import { existsSync, readFileSync } from "node:fs";
import { configFile } from "./paths";

export interface Config {
  // Notify when an agent goes idle (in addition to the always-on
  // needs-attention notifications).
  notifyOnIdle: boolean;
  // Minimum length of the work stint, in seconds, before idle is
  // notification-worthy — filters out quick conversational replies.
  idleNotifyMinSeconds: number;
  // Launch agents with Claude Code Remote Control, making them drivable from
  // claude.ai/code and the Claude mobile app. Per-agent override via
  // `am new --remote / --no-remote`.
  remoteControl: boolean;
  // macOS bundle id notifications are posted as (icon + click target), e.g.
  // "com.mitchellh.ghostty" or "com.googlecode.iterm2". Requires
  // terminal-notifier (brew install terminal-notifier); without it — or with
  // this unset — notifications fall back to osascript (Script Editor icon).
  notifySender?: string;
}

const DEFAULTS: Config = {
  notifyOnIdle: true,
  idleNotifyMinSeconds: 30,
  remoteControl: true,
};

export function loadConfig(): Config {
  if (!existsSync(configFile())) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configFile(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function shouldNotifyIdle(opts: {
  config: Config;
  workedSeconds: number;
  queueDepth: number;
  attached: boolean;
}): boolean {
  if (!opts.config.notifyOnIdle) return false;
  if (opts.attached) return false; // you're already looking at it
  if (opts.queueDepth > 0) return false; // a queued message is about to deliver
  return opts.workedSeconds >= opts.config.idleNotifyMinSeconds;
}
