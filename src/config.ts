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
  // Overrides the built-in notifiers on any platform: run via `sh -c` with
  // $AM_TITLE and $AM_MESSAGE set. On a headless server, point this at a
  // push service (e.g. curl -d "$AM_MESSAGE" ntfy.sh/<topic>).
  notifyCommand?: string;
  // ssh host aliases whose agents appear alongside local ones in ls, the
  // picker, and the hub (each must have am installed and on PATH).
  remotes?: string[];
  // Spawn agents into a fresh git worktree (branch am/<name>) when the
  // target dir is a repo, instead of assuming ownership of the checkout.
  // Per-agent opt-out: am new --in-place.
  worktreeByDefault: boolean;
  // `am serve` (the HTTP API + PWA for phones) listens here. Bind defaults to
  // loopback — point it at a tailnet IP, or keep loopback and front it with
  // Caddy/tailscale serve. NEVER 0.0.0.0 without a network gate: the API can
  // spawn agents and run commands.
  apiPort: number;
  apiBind: string;
  // Inter-agent comms loop guard: at most this many attributed messages from
  // the same sender to the same target within commsWindowSeconds. Excess sends
  // are dropped with a warning — the hard backstop against A→B→A ping-pong.
  commsMaxPerWindow: number;
  commsWindowSeconds: number;
  // What other machines call THIS host (its alias in their config.remotes).
  // When set, sends forwarded to another host carry `--from <hostAlias>:<name>`
  // so the recipient can address a reply back. Unset → bare name + global
  // fleet resolution (fine as long as agent names are unique across the fleet).
  hostAlias?: string;
  // How long an outbox message (a send to an unreachable target, queued for a
  // collector to pick up) stays valid before it expires undelivered.
  outboxTtlHours: number;
  // Outbox poll cadence is adaptive: outboxPollSeconds is the HOT floor (used
  // right after mail arrives), backing off ×1.5 up to outboxPollMaxSeconds when
  // idle, snapping back to hot on the next message. Lower floor = snappier
  // delivery; higher cap = cheaper idle. 0 disables collection entirely.
  outboxPollSeconds: number;
  outboxPollMaxSeconds: number;
  // Server-side port that `am tunnel` opens to reach back to a roaming host's
  // sshd (reverse SSH). The server addresses the tunneled host via an ssh Host
  // alias pointing at localhost:<tunnelPort>.
  tunnelPort: number;
}

const DEFAULTS: Config = {
  notifyOnIdle: true,
  idleNotifyMinSeconds: 30,
  remoteControl: true,
  apiPort: 8787,
  apiBind: "127.0.0.1",
  worktreeByDefault: true,
  commsMaxPerWindow: 5,
  commsWindowSeconds: 60,
  outboxTtlHours: 48,
  outboxPollSeconds: 2,
  outboxPollMaxSeconds: 30,
  tunnelPort: 2222,
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
