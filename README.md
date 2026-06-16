# am — coding agent manager

A small CLI for running multiple [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex/cli) agents at once and jumping between them fast. Each agent is a real interactive `claude` or `codex` session in its own tmux session; provider hooks report status (working / idle / needs attention) and deliver queued messages the moment an agent goes idle. An idle agent whose screen shows a scheduled wake-up or a running background task is displayed as `waiting` (◐) instead — best-effort, detected from the pane content since hooks carry no such signal.

```
$ am
agents (3) · f filters         │ ⏺ Updating src/api/client.ts…
❯ ● api-refactor   working 2q  │ ✻ Churning (12s · 8.2k tokens)
  ⚠ bugfix-381  needs-attention│
  ○ docs-pass             idle │
                               │
status   working (2 queued)    │
dir      ~/code/api            │
task     refactor the api layer│
updated  12s ago               │
f filter · ↑/↓/j/k preview     │
enter/→ lock in · n new        │
```

The picker is a full-screen split view: agents and their details in the left
sidebar, a live preview of the highlighted agent's screen on the right,
refreshed every second — peek at what each agent is doing without attaching.
`ctrl-n` spawns a new agent right from the picker (it prompts for a name and
an optional task, then jumps into the new session).

## Install

Requires [Bun](https://bun.sh), tmux, and Claude Code. Codex (≥0.133, for `--codex` agents) is optional.

```sh
git clone https://github.com/lalexgap/agent-manager.git
cd agent-manager
bun install
bun link
```

## Usage

```sh
am new api-refactor -m "refactor the api layer"   # spawn in current dir and jump in
am new bugfix --dir ~/code/other-repo             # spawn elsewhere
am new quiet-one --no-jump                        # spawn without attaching
am new perf --worktree perf-tuning                # spawn in a fresh git worktree
am new gpt-take --codex                           # run Codex instead of Claude Code
am new triage --resume                            # adopt an existing conversation
                                                  # (opens the provider's session picker;
                                                  #  --resume <id> / --continue also work)

am                       # split view: sidebar + live agent pane
                         # (scrolling previews agents, enter/→ locks input
                         #  into the pane, ctrl-q back to the sidebar,
                         #  esc detach, ctrl-c quit)
am pick                  # classic fullscreen picker (enter attaches)
am j api                 # jump by prefix
am -                     # jump back to the previous agent
am ls                    # status table (--json for scripting)

am send api "then update the changelog"    # queued; delivered when idle
am send api --now "prefer the v2 endpoint" # typed in immediately (steers current turn)
am send api --file ./patch.diff            # hand off a file (cross-machine too)
am interrupt api "stop — wrong branch"     # Esc to abort the turn, then send

am report api --to lead   # api now reports progress to lead (see below)
am comms api              # recent messages to/from api

am search "rate limit"   # full-text search across every agent's chat; prints
                         # matches + snippets + the command to pick each up
                         # (--all spans past sessions too; --fleet spans remotes)

am transcript api        # render the agent's conversation as markdown
                         # (--full keeps complete tool output; --out <file>)
am handoff api           # hand the work to a fresh agent on the OTHER provider,
                         # briefed with the transcript (--to claude|codex to pick)

am queue api             # show pending messages (--clear to drop them)
am stop api              # kill the session but keep state (resumable)
am resume api            # restart an exited agent, resuming its conversation
am rm api                # kill session + state (--clean also removes the worktree)

am watch                 # live status table, fed by the daemon
am daemon status         # the daemon is auto-started by `am new`

am serve                 # HTTP API + installable PWA to watch/message the fleet
                         # from a phone (token-gated; put it behind a tailnet)
am token                 # print the bearer token to paste into the PWA
```

### Agents talking to each other

Agents can message each other with the same `am send` you use — and `am` adds
the structure that makes a conversation work:

- **Attribution is automatic.** A send from inside an agent's session is stamped
  with who sent it, so the recipient sees `[am · from api] tests are green` and
  knows it's a peer (not you, the operator). Replying is just
  `am send api "..."` — it routes back wherever `api` runs, across machines.
  Cross-host senders are qualified (`[am · from laptop:api]`) so the reply still
  finds them. A question and its answer close with nothing extra.

- **Standing report relationships.** Give an agent a lead to keep posted:

  ```sh
  am new worker -m "…" --report-to lead   # report to a named agent
  am new worker -m "…" --report           # …to whoever spawned it
  am report worker --to lead              # set/change later (--clear to drop)
  ```

  The agent is briefed to post its own summaries with `am send lead`. As a
  backstop, when it finishes a real work stint without reporting, `am` sends
  `lead` a terse "went idle after 4m · task: …" so the lead always hears
  something.

- **Handing off files.** `am send <name> --file <path>` ships a file to another
  agent — across machines too. It lands in the recipient's inbox
  (`~/.agent-manager/inbox/<name>/`, so it never touches their repo) and the
  agent gets an attributed note pointing at the path:

  ```sh
  am send web --file ./report.pdf                  # → web's inbox + a note
  am send box:web "ship this build" --file app.zip # to web on host `box`
  ```

  Remote handoffs scp the bytes over and forward only the note, reusing the same
  transport as `am move`.

- **Reaching a roaming agent (store-and-forward).** Cross-machine sends work
  laptop→server directly (the laptop can ssh in). The reverse — server→laptop,
  when the laptop roams and runs no sshd — has no live transport, so a send to an
  unreachable target lands in an **outbox** instead of erroring:

  ```sh
  am send laptop-agent "the nightly finished"   # → queued in outbox for pickup
  am outbox                                      # inspect what's waiting
  ```

  The laptop's daemon sweeps each configured remote's outbox on an adaptive
  cadence (hot `outboxPollSeconds`≈2s after mail, backing off to
  `outboxPollMaxSeconds`≈30s when idle; `0` disables), pulls anything addressed
  to its local agents, and delivers it attributed by origin (`[am · from
  server:web] …`, the same `host:name` you reply with). Pickup is
  **at-least-once with dedup** (claim/ack/reclaim + message IDs) so a collector
  crash never loses mail; ssh connection multiplexing keeps the frequent polls
  cheap. Entries expire after ~48h (`outboxTtlHours`) with a bounce surfaced to
  the sender — never a silent drop. (Both machines need this version of `am` for
  the round trip.)

- **Live reverse reach (optional).** For real-time server→laptop while the laptop
  is online, `am tunnel <server>` on the laptop opens a reverse SSH tunnel so the
  server can reach back to it; add it to the server's `config.remotes` and the
  fleet works both ways (shared agent list, live sends). Falls back to the outbox
  when the laptop is offline. See [docs/reverse-ssh.md](docs/reverse-ssh.md).

- **Loop-safe.** A per-pair rate limiter (default 5 messages / 60s, tunable via
  `commsMaxPerWindow` / `commsWindowSeconds` in config) drops runaway A→B→A
  chatter with a warning — at injection time, so a cross-machine loop trips the
  same guard. `am comms <name>` shows the recent traffic the limiter sees.

### Phone access (PWA)

`am serve` starts a small HTTP server that exposes the fleet as a JSON API and
serves an installable web app (PWA) — a phone-friendly version of `am ls` plus
the detail view: live status across every machine, the agent's last screen, and
queue / send-now / interrupt / spawn / stop. Open the URL it prints, paste the
token from `am token`, and "Add to Home Screen" to install it.

**It is not exposed to the internet, by design.** The API can spawn agents and
run commands, so it's a remote-code-execution surface: bind it to your
[Tailscale](https://tailscale.com) tailnet (set `"apiBind"` to the tailnet IP in
`~/.agent-manager/config.json`), or keep the loopback default and front it with
Caddy/`tailscale serve` for HTTPS. Every `/api` route requires the bearer token
as defence-in-depth — but the network gate is what keeps it safe. Run it under
systemd with `docs/am-serve.service`. Push notifications stay on the existing
`notifyCommand` path (point it at [ntfy](https://ntfy.sh) for the phone). The
full design rationale — public-vs-private exposure, PWA auth, native-app
trade-offs — is in [`docs/ios-app-exploration.md`](docs/ios-app-exploration.md).

### Scrolling and copying text

Scroll with the mouse wheel — wheeling up enters tmux scrollback, wheeling back down to the bottom returns to the live view (`Page Up` works too, `q`/`Esc` to bail out). For copying, hold **Shift** (Ghostty, Alacritty, Kitty) or **Option** (iTerm2, Terminal.app) while dragging to select text natively, then ⌘C as usual — the modifier is needed because the wheel handling puts the terminal in mouse mode. To grab an agent's screen without attaching: `tmux capture-pane -t 'agentmgr-<name>:' -p | pbcopy`.

### Leaving an agent without killing it

Inside an agent's session, press **`ctrl-q`** — it detaches (the agent keeps working) and, when you arrived via the `am` picker, drops you straight back into the picker with that agent highlighted. The binding lives in a per-session tmux key table, so it only applies to agent sessions. Plain tmux detach (`ctrl-b d`) works too, as do `ctrl-b s` / `ctrl-b (` / `)` for hopping between sessions natively. Exiting Claude Code itself (`/exit` or ctrl-d twice) ends the session; the agent shows as `exited` in `am ls` and can be brought back with `am resume`, which reopens the same conversation (hooks record Claude's session id).

## How it works

- **tmux**: `am new <name>` starts `claude` inside a detached tmux session named `agentmgr-<name>`. Jumping attaches (or `switch-client`s when you're already inside tmux), so you always get Claude Code's native UI.
- **Hooks**: claude agents are launched with `claude --settings ~/.agent-manager/hook-settings.json`, a generated file wiring SessionStart / UserPromptSubmit / Stop / Notification / SessionEnd to `am hook <event>`. Your normal `claude` sessions are untouched. Hooks identify their agent via the `AGENTMGR_AGENT` env var set on the tmux session.
- **Codex agents**: `am new --codex` runs Codex, whose hook system mirrors Claude Code's. Codex has no per-launch settings flag and its hook trust is keyed to the config file a hook lives in, so `am` installs its hook block persistently into `~/.codex/config.toml` (guarded by `AGENTMGR_AGENT`, inert in your own codex sessions). The first managed launch shows Codex's hooks review — choose **Trust all and continue** (one-time; the trust hash survives until am's paths change). Codex fires SessionStart at the first turn rather than TUI launch, so a fresh codex agent reads `starting` until its first prompt; approvals surface via the dedicated PermissionRequest event.
- **Handoff**: `am handoff <name>` renders the agent's native session file (Claude: `~/.claude/projects/...`, Codex: `~/.codex/sessions/...` — captured from hook payloads) into markdown under `~/.agent-manager/handoffs/`, then spawns a fresh agent on the other provider briefed with it. Neither CLI can adopt the other's session natively, so the handoff is a context briefing: the new agent is told to re-verify repo state rather than trust stale tool output. The source agent keeps running until you stop it.
- **Queue**: `am send` appends to `~/.agent-manager/queue/<name>.jsonl`. When the agent finishes a turn, its Stop hook pops the next message and types it into the session via `tmux send-keys`.
- **Daemon**: a small background process (auto-started by `am new`) serving HTTP over a unix socket at `~/.agent-manager/daemon.sock`. It schedules queue delivery, sweeps dead sessions, and feeds `am watch`. It's an accelerator, not a requirement — if it's down, hooks fall back to handling delivery themselves, so nothing breaks.
- **Notifications**: macOS notifications fire when an agent needs your attention (permission prompts), and when one goes idle after real background work — filtered so you're not pinged for agents you're currently watching, quick replies (default threshold 30s of work, tune `idleNotifyMinSeconds` in `~/.agent-manager/config.json`), or agents about to receive a queued message. Notifications come from the hooks, so they work even with no `am` process or daemon running.
- **Remote control**: agents launch with [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) enabled by default, so every agent appears in claude.ai/code and the Claude mobile app's session list and can be driven from there — the session keeps running locally with all its tools. Disable globally with `"remoteControl": false` in `~/.agent-manager/config.json`, or per agent with `--no-remote` (`--remote` forces it on). Note: with remote control on, the initial `-m` message is delivered via the queue at session start, since the flag would otherwise swallow it as the remote session's name.
- **Worktrees by default**: spawning an agent into a git repo gives it a
  fresh worktree on branch `am/<name>` instead of taking over the checkout —
  agents are guests, not owners. `--in-place` runs in the dir as-is,
  `--worktree <branch>` picks the branch, `"worktreeByDefault": false` turns
  it off. Moves recreate the worktree on the target (pushing the branch to
  origin when possible so commits travel).
- **Fleet across machines**: list ssh hosts in `"remotes"` in
  `~/.agent-manager/config.json` and their agents appear alongside local ones
  in `am ls` (HOST column), the picker, and the hub — where selecting a
  remote agent nests an `ssh -t … tmux attach` right in the pane. Agent
  commands resolve across the fleet (`am send demo "..."` finds demo wherever
  it lives; `host:name` disambiguates). `am move <name> <host>` (or
  `am move <host>:<name>` to pull) migrates an agent for real: state, queue,
  and the provider's conversation file travel, the working dir is mapped to
  the same $HOME-relative path (repos are assumed cloned on both sides;
  uncommitted changes never travel), and the agent resumes on the target with its
  context intact.
- **Durable agents**: agents survive as more than processes. The initial task is stored and searchable in the picker (`f` filters name, task, and directory; `/` searches the full chat text), the Stop hook keeps a last-screen snapshot so dead agents still show a preview, and conversations persist on disk — so days later you can find an agent by what it said (`am search`, or `/` in the picker) and `am resume` it with its context intact, even across reboots (tmux sessions die on reboot; the agent's identity and conversation don't).

All state lives in `~/.agent-manager/` as plain JSON — easy to inspect, easy to nuke.

## Development

```sh
bun test
```
