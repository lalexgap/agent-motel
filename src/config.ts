import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { configFile } from "./paths";
import { isProvider, type Provider } from "./state";

export function shortHost(host: string): string {
  return host.split(".")[0] || host;
}

// What the rest of the fleet (and the operator) calls THIS machine: the
// configured alias when set, else the short hostname.
export function localHostIdentity(): string {
  return loadConfig().hostAlias || shortHost(hostname());
}

export interface Config {
  // PR lifecycle polling interval; 0 disables. Positive values have a 30s floor.
  prPollSeconds: number;
  // Provider a new agent runs on when no provider flag is given
  // (and, in the create form, the preselected provider). "codex", "claude", or "antigravity".
  defaultProvider: Provider;
  // Notify when an agent goes idle (in addition to the always-on
  // needs-attention notifications).
  notifyOnIdle: boolean;
  // Minimum length of the work stint, in seconds, before idle is
  // notification-worthy — filters out quick conversational replies.
  idleNotifyMinSeconds: number;
  // Launch agents with remote control: Claude Code Remote Control, or for
  // codex, attached to the app-server daemon. Antigravity defaults off and
  // does not support remote control. Per-agent override via
  // `am new --remote / --no-remote`.
  remoteControl: boolean;
  // macOS: post through iTerm2 (OSC 9 to an attached tmux client in iTerm2)
  // when one exists, for the iTerm2 icon. Default on; false keeps osascript.
  itermNotifications?: boolean;
  // Overrides the built-in notifiers on any platform: run via `sh -c` with
  // $AM_TITLE and $AM_MESSAGE set. On a headless server, point this at a
  // push service (e.g. curl -d "$AM_MESSAGE" ntfy.sh/<topic>).
  notifyCommand?: string;
  // The daemon relays notifications from every host in `remotes` to this
  // machine's notifier (default on; only runs where a notifier exists). Set
  // false to keep each host's notifications to itself.
  relayNotifications?: boolean;
  // ssh host aliases whose agents appear alongside local ones in ls, the
  // picker, and the hub (each must have am installed and on PATH).
  remotes?: string[];
  // Provider the fleet concierge runs on. Applies when the concierge is
  // created; to switch an existing one, `am rm concierge` and reopen it.
  conciergeProvider: Provider;
  conciergeModel?: string;
  conciergeEffort?: string;
  conciergeAutoStart?: boolean;
  webOrigin?: string;
  caretakerModel?: string;
  caretakerEffort?: string;
  // Where the fleet concierge lives: "local" or an ssh host alias (usually one
  // of `remotes`). Every machine with the same value routes `am concierge` and
  // the hub's `c` key to that single agent. Unset = adopt an existing
  // concierge anywhere in the fleet (local first), create locally otherwise.
  conciergeHost?: string;
  // Spawn agents into a fresh git worktree (branch am/<name>) when the
  // target dir is a repo, instead of assuming ownership of the checkout.
  // Per-agent opt-out: am new --in-place.
  worktreeByDefault: boolean;
  // Launch agents permissionless — no per-command approval prompts. Managed
  // agents run unattended, and a prompt would hang an agent nobody is
  // watching. claude gets --dangerously-skip-permissions; codex gets
  // --dangerously-bypass-approvals-and-sandbox. Set false to restore prompts.
  skipPermissions: boolean;
  // `am serve` (the HTTP API for phone/remote clients) listens here. Bind defaults to
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
  // Show provider quota headroom (see `am usage`) in the picker/hub footer.
  // Costs one Claude usage request a minute while the UI is open; set false
  // to keep the UI entirely offline.
  showUsage: boolean;
  // `am gc` retention: agents whose session is gone and untouched for this
  // many days are reaped (to trash); trash snapshots older than gcTrashDays
  // are purged. Per-run override: --agent-days / --trash-days.
  gcAgentDays: number;
  gcTrashDays: number;
  // Worktree retention, for `am gc` and the scheduled sweep alike. A worktree
  // a registered agent owns is never collected; these say when the others go.
  //   gcMergedDays   after every pull request an exited agent tracks has
  //                  merged: the agent is reaped (to trash) and its worktree
  //                  released
  //   gcRemovedDays  after `am rm` (or a reap): how long the worktree is held
  //                  for `am restore`, which recreates it from its branch later
  //   gcOrphanDays   without activity, for a worktree no agent owns and for
  //                  subagent worktrees nested in an agent's worktree
  //   gcStaleDays    without a change, for an unowned worktree that is dirty or
  //                  unpushed: its changes are saved to refs/am-gc/ in the
  //                  repository, then it is removed. 0 keeps them forever.
  //   gcIgnoredDays  the same, for one whose only leftovers are git-ignored
  //                  files (env files, keys, node_modules), which are not
  //                  saved. 0 treats those like any other change.
  //   gcFileDays     for handoff transcripts and cached shared files
  // A file named .am-gc-keep in a worktree keeps it regardless.
  gcMergedDays: number;
  gcRemovedDays: number;
  gcOrphanDays: number;
  gcStaleDays: number;
  gcIgnoredDays: number;
  gcFileDays: number;
  // The daemon runs gc on its own: nightly at gcAutoHour (local time), or at
  // the next idle moment after a missed night. After an upgrade it only reports
  // until its runs have looked at every worktree once; later runs apply. The
  // sweep runs at the lowest CPU/IO priority, one worktree at a time, for at
  // most gcAutoMaxMinutes, and waits while the 1-minute load per CPU is above
  // gcAutoMaxLoad or IO/memory pressure (PSI some avg10, Linux) above
  // gcAutoMaxPressure. `am gc --auto pause` stops it without editing this file.
  gcAuto: boolean;
  gcAutoHour: number;
  gcAutoMaxMinutes: number;
  gcAutoMaxLoad: number;
  gcAutoMaxPressure: number;
  // How long a Claude permission prompt waits for an `am serve` client to
  // answer it before the pane's own prompt is the only way left. 0 turns the
  // relay off. Codex approvals have no deadline: they stay answerable from
  // either side until one answers.
  permissionWaitSeconds: number;
  // Mark a new Claude agent's folder as trusted in ~/.claude.json, so it
  // doesn't stall at "Is this a project you created or one you trust?". Only
  // folders with no recorded answer are written, never ~ or above, and only
  // while skipPermissions is on; `am gc` removes am's entries once their
  // folder is gone. Set false to answer the prompt yourself.
  pretrustClaudeDirs: boolean;
  // Keep a running plan file per agent (am plan <name>), injected into its
  // context once per session. Per-agent opt-out: am new --no-plan.
  plans: boolean;
  // Read each agent's `decision` store (the decisions skill): `am ls` and
  // `am summary` show open decisions, and the prompt/stop hooks run
  // `decision hook` when the CLI is installed. false turns all of it off.
  decisions: boolean;
  // What the stop hook does when a turn ends on a question nothing registered:
  // "block" makes the agent register it before stopping, "nudge" reminds it on
  // the next prompt, "off" skips the check.
  decisionsStopMode: "block" | "nudge" | "off";
  // `am switch-model` lets an agent change its own model during its first N
  // turns, while the uncached re-read of the conversation is still cheap.
  // 0 disables it.
  selfModelSwitchMaxTurns: number;
}

const DEFAULTS: Config = {
  prPollSeconds: 120,
  defaultProvider: "codex",
  conciergeProvider: "codex",
  notifyOnIdle: true,
  idleNotifyMinSeconds: 30,
  remoteControl: true,
  apiPort: 8787,
  apiBind: "127.0.0.1",
  worktreeByDefault: true,
  skipPermissions: true,
  commsMaxPerWindow: 5,
  commsWindowSeconds: 60,
  outboxTtlHours: 48,
  outboxPollSeconds: 2,
  outboxPollMaxSeconds: 30,
  tunnelPort: 2222,
  showUsage: true,
  gcAgentDays: 7,
  gcTrashDays: 30,
  gcMergedDays: 3,
  gcRemovedDays: 7,
  gcOrphanDays: 3,
  gcStaleDays: 30,
  gcIgnoredDays: 7,
  gcFileDays: 30,
  gcAuto: true,
  gcAutoHour: 4,
  gcAutoMaxMinutes: 15,
  gcAutoMaxLoad: 1,
  gcAutoMaxPressure: 20,
  permissionWaitSeconds: 120,
  pretrustClaudeDirs: true,
  plans: true,
  decisions: true,
  decisionsStopMode: "block",
  selfModelSwitchMaxTurns: 2,
};

export function loadConfig(): Config {
  if (!existsSync(configFile())) return { ...DEFAULTS };
  let stored: Partial<Config>;
  try {
    stored = JSON.parse(readFileSync(configFile(), "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { ...DEFAULTS };
  for (const key of ["defaultProvider", "conciergeProvider"] as const) {
    if (key in stored && !isProvider(stored[key])) throw new Error(`${key} must be a provider: claude, codex, or antigravity`);
  }
  return { ...DEFAULTS, ...stored };
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
