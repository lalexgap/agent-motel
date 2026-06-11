# am — Claude agent manager

A small CLI for running multiple [Claude Code](https://claude.com/claude-code) agents at once and jumping between them fast. Each agent is a real interactive `claude` session in its own tmux session; Claude Code hooks report status (working / idle / needs attention) and deliver queued messages the moment an agent goes idle.

```
$ am
❯ ● api-refactor   working     2 queued
  ⚠ bugfix-381     needs-attention
  ○ docs-pass      idle
  (type to filter · ↑/↓ · enter jumps · ctrl-x stop · ctrl-d remove · esc)
  ──────────────────────────────── api-refactor
  ⏺ Updating src/api/client.ts…
  ✻ Churning (12s · 8.2k tokens)
```

The picker shows a live preview of the highlighted agent's screen, refreshed
every second — peek at what each agent is doing without attaching.

## Install

Requires [Bun](https://bun.sh), tmux, and Claude Code.

```sh
git clone https://github.com/lalexgap/agent-manager.git
cd agent-manager
bun install
bun link
```

## Usage

```sh
am new api-refactor -m "refactor the api layer"   # spawn in current dir
am new bugfix --dir ~/code/other-repo             # spawn elsewhere
am new perf --worktree perf-tuning                # spawn in a fresh git worktree
am new triage --resume                            # adopt an existing conversation
                                                  # (opens Claude's session picker;
                                                  #  --resume <id> / --continue also work)

am                       # interactive picker → jump
am j api                 # jump by prefix
am -                     # jump back to the previous agent
am ls                    # status table (--json for scripting)

am send api "then update the changelog"    # queued; delivered when idle
am send api --now "prefer the v2 endpoint" # typed in immediately (steers current turn)
am interrupt api "stop — wrong branch"     # Esc to abort the turn, then send

am queue api             # show pending messages (--clear to drop them)
am stop api              # kill the session but keep state (resumable)
am resume api            # restart an exited agent, resuming its conversation
am rm api                # kill session + state (--clean also removes the worktree)

am watch                 # live status table, fed by the daemon
am daemon status         # the daemon is auto-started by `am new`
```

### Copying text

Just drag — agent sessions run with tmux mouse mode on, so a click-drag selects via tmux (Claude Code's own mouse handling can't swallow it) and releasing copies the selection straight to the macOS clipboard. No modifier keys, no ⌘C. Wheel scrolling still goes to Claude Code. Mouse mode is per-session, so your other tmux sessions are unaffected.

### Leaving an agent without killing it

Inside an agent's session, press **`ctrl-q`** — it detaches (the agent keeps working) and, when you arrived via the `am` picker, drops you straight back into the picker with that agent highlighted. The binding lives in a per-session tmux key table, so it only applies to agent sessions. Plain tmux detach (`ctrl-b d`) works too, as do `ctrl-b s` / `ctrl-b (` / `)` for hopping between sessions natively. Exiting Claude Code itself (`/exit` or ctrl-d twice) ends the session; the agent shows as `exited` in `am ls` and can be brought back with `am resume`, which reopens the same conversation (hooks record Claude's session id).

## How it works

- **tmux**: `am new <name>` starts `claude` inside a detached tmux session named `agentmgr-<name>`. Jumping attaches (or `switch-client`s when you're already inside tmux), so you always get Claude Code's native UI.
- **Hooks**: agents are launched with `claude --settings ~/.agent-manager/hook-settings.json`, a generated file wiring SessionStart / UserPromptSubmit / Stop / Notification / SessionEnd to `am hook <event>`. Your normal `claude` sessions are untouched. Hooks identify their agent via the `AGENTMGR_AGENT` env var set on the tmux session.
- **Queue**: `am send` appends to `~/.agent-manager/queue/<name>.jsonl`. When the agent finishes a turn, its Stop hook pops the next message and types it into the session via `tmux send-keys`.
- **Daemon**: a small background process (auto-started by `am new`) serving HTTP over a unix socket at `~/.agent-manager/daemon.sock`. It schedules queue delivery, sweeps dead sessions, and feeds `am watch`. It's an accelerator, not a requirement — if it's down, hooks fall back to handling delivery themselves, so nothing breaks.
- **Notifications**: macOS notifications fire when an agent needs your attention (permission prompts), and when one goes idle after real background work — filtered so you're not pinged for agents you're currently watching, quick replies (default threshold 30s of work, tune `idleNotifyMinSeconds` in `~/.agent-manager/config.json`), or agents about to receive a queued message. Notifications come from the hooks, so they work even with no `am` process or daemon running.
- **Durable agents**: agents survive as more than processes. The initial task is stored and searchable in the picker (filter matches name, task, and directory), the Stop hook keeps a last-screen snapshot so dead agents still show a preview, and conversations persist on disk — so days later you can find an agent by what it was doing and `am resume` it with its context intact, even across reboots (tmux sessions die on reboot; the agent's identity and conversation don't).

All state lives in `~/.agent-manager/` as plain JSON — easy to inspect, easy to nuke.

## Development

```sh
bun test
```
