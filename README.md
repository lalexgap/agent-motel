# Agent Motel

Agent Motel is a CLI for running multiple [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex/cli) agents in parallel. Each agent gets an isolated tmux session, live status, a message queue, and—by default—its own git worktree.

```text
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

The full-screen hub shows every agent in a sidebar with a live preview of the selected session. Use it to switch agents, check progress, send follow-ups, or let agents collaborate across machines. Press `ctrl-p` for a searchable command palette.

## Install

Requires [Bun](https://bun.sh), tmux, and at least one supported agent CLI:

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://developers.openai.com/codex/cli) 0.133 or newer

```sh
git clone https://github.com/lalexgap/agent-motel.git
cd agent-motel
bun install
bun link
```

## Quick start

```sh
am new api-refactor -m "refactor the API layer"  # create and attach
am new bugfix --dir ~/code/other-repo            # use another repo
am new gpt-take --codex --no-jump                # use Codex, stay in the hub

am                         # open the hub
am ls                      # list agents (--json for scripts)
am j api                   # jump by name prefix
am -                       # return to the previous agent
```

Agents created in a git repository get a worktree on `am/<name>`. Pass `--in-place` to use the current checkout or `--worktree <branch>` to choose a branch.

## Common commands

### Create and navigate

```sh
am new <name> -m "task"                 # create an agent
am new <name> --resume [session-id]     # adopt an existing conversation
am run <name> -m "task"                # create, wait, and print the answer
am pick                                 # open the classic picker
am peek <name>                          # print the current screen
```

In the hub, use `↑`/`↓` or `j`/`k` to select an agent, `Enter` or `→` to control it, `ctrl-q` to return to the sidebar, `ctrl-n` to create an agent, and `Esc` to detach. Inside an attached session, `ctrl-q` returns to the hub without stopping the agent.

### Message and coordinate

```sh
am send api "then update the changelog"       # deliver when idle
am send api --now "use the v2 endpoint"       # steer the current turn
am interrupt api "stop—wrong branch"          # abort, then redirect
am send api --file ./patch.diff                # hand off a file
am send api "run tests" && am wait api         # wait for the response

am report worker --to lead                     # set a reporting relationship
am comms worker                                # inspect agent messages
am queue worker                                # inspect pending messages
```

Messages sent from one managed agent to another are automatically attributed, including across machines. File handoffs land in `~/.agent-manager/inbox/<name>/`. A per-pair rate limit prevents runaway agent loops.

### Preserve and hand off work

```sh
am transcript api                  # render the conversation as Markdown
am search "rate limit"             # search agent conversations
am handoff api --to codex          # continue with the other provider
am stop api                        # stop but keep resumable state
am resume api                      # restart the same conversation
am rm api                          # remove an agent; state remains restorable
am restore api                     # restore a removed agent
am gc                              # preview cleanup (--apply to run it)
```

Run `am --help` for the complete command and option reference.

## Remote fleets

Add SSH hosts to `remotes` in `~/.agent-manager/config.json` to manage their agents alongside local ones.

```sh
am -H server                       # open the hub on a remote host
am ls                              # list the combined fleet
am move api server                 # move an agent and its conversation
am clone api server                # copy it and keep the source running
am send server:api "ship it"       # address a specific host
```

Messages to an unreachable roaming machine use a durable outbox and are collected when it reconnects. For live reverse access, see [Reverse SSH](docs/reverse-ssh.md).

## HTTP API

```sh
am serve
am token
```

The token-protected API can list, message, create, stop, and resume agents, with live fleet updates at `/api/events`. It can execute code through spawned agents, so keep it on loopback or behind a private network such as [Tailscale](https://tailscale.com). Do not expose it directly to the internet. A sample systemd unit is available at [`docs/am-serve.service`](docs/am-serve.service).

## How it works

- **Sessions:** Each agent runs in a detached tmux session, so it keeps working when you leave.
- **Status and queues:** Provider hooks update status and deliver queued messages after a turn. A small auto-started daemon streams changes to the hub and HTTP API, but is not required for delivery.
- **Persistence:** Tasks, snapshots, queues, and conversation references live as plain files under `~/.agent-manager/`.
- **Providers:** Claude hooks use generated per-launch settings. Agent Motel installs guarded hooks in `~/.codex/config.toml` for Codex; approve **Trust all and continue** on the first managed launch.

Claude Code Remote Control is enabled by default. Disable it with `--no-remote` for one agent or `"remoteControl": false` in `~/.agent-manager/config.json`.

## Development

```sh
bun test
```
