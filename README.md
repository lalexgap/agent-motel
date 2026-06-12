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
am interrupt api "stop — wrong branch"     # Esc to abort the turn, then send

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
```

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
- **Fleet across machines**: list ssh hosts in `"remotes"` in
  `~/.agent-manager/config.json` and their agents appear alongside local ones
  in `am ls` (HOST column), the picker, and the hub — where selecting a
  remote agent nests an `ssh -t … tmux attach` right in the pane. Agent
  commands resolve across the fleet (`am send demo "..."` finds demo wherever
  it lives; `host:name` disambiguates). `am move <name> <host>` (or
  `am move <host>:<name>` to pull) migrates an agent for real: state, queue,
  and the provider's conversation file travel, the working dir is mapped to
  the same $HOME-relative path (repos are assumed cloned on both sides;
  dirty git aborts the move), and the agent resumes on the target with its
  context intact.
- **Durable agents**: agents survive as more than processes. The initial task is stored and searchable in the picker (filter matches name, task, and directory), the Stop hook keeps a last-screen snapshot so dead agents still show a preview, and conversations persist on disk — so days later you can find an agent by what it was doing and `am resume` it with its context intact, even across reboots (tmux sessions die on reboot; the agent's identity and conversation don't).

All state lives in `~/.agent-manager/` as plain JSON — easy to inspect, easy to nuke.

## Development

```sh
bun test
```
