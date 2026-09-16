# Agent Motel

Agent Motel is a CLI for running multiple [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex/cli) agents in parallel. Each agent gets an isolated tmux session, live status, a message queue, and—by default—its own git worktree.

```text
$ am
agents (3) · f filters         │ ⏺ Updating src/api/client.ts…
❯ ● api-refactor          2q   │ ✻ Churning (12s · 8.2k tokens)
  ⚠ bugfix-381                 │
  ○ docs-pass                  │
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
am new claude-take --claude --no-jump            # use Claude Code, stay in the hub

am                         # open the hub
am ls                      # list agents (--json; --role/--sort for scripts)
am summary                 # prioritized attention/active/idle fleet report
am usage                   # quota headroom for claude and codex
am j api                   # jump by name prefix
am -                       # return to the previous agent
```

Agents created in a git repository get a worktree on `am/<name>`. Pass `--in-place` to use the current checkout or `--worktree <branch>` to choose a branch.

## Common commands

### Create and navigate

```sh
am new <name> -m "task"                 # create an agent
am new <name> -m "task" --role reviewer # apply custom instructions
am new <name> --resume [session-id]     # adopt an existing conversation
am run <name> -m "task"                # create, wait, and print the answer
am pick                                 # open the classic picker
am peek <name>                          # print the current screen
```

Agents run on Codex by default. `--claude` or `--codex` picks the provider for one agent; `"defaultProvider": "claude" | "codex"` in `~/.agent-manager/config.json` changes the default for all of them.

In the hub, use `↑`/`↓` or `j`/`k` to select an agent, `Enter` or `→` to control it, `ctrl-q` to return to the sidebar, `ctrl-n` to create an agent, `r` to filter by role, `s` to cycle status/recent/role sorting, and `Esc` to detach. Inside an attached session, `ctrl-q` returns to the hub without stopping the agent.

### Models and reasoning effort

```sh
am models                               # what claude and codex offer here
am models --json --codex                # machine-readable, one provider
am -H server models                     # ask another machine
am new deep-dive --codex --model gpt-5.6-sol --effort ultra
```

Model and effort options come from the installed CLIs rather than a hardcoded list: codex reports its own catalog (including which reasoning levels each model supports — `ultra` exists only on the newest), and claude's levels are read from its `--help`, so new ones appear as soon as you upgrade. The hub's create form cycles the real options with `←`/`→` — for the machine the agent will run on, so a remote host's catalog is used when you pick it as the location — and the model field still accepts a typed name. `am new` / `am run` reject a `--model` or `--effort` the provider can't accept instead of spawning a session that dies on startup; claude's model list isn't exhaustive, so an unrecognized model there is only a warning.

### Fleet concierge

```sh
am concierge                                  # open the fleet assistant
am concierge which agent touched the auth flow?
```

`concierge` is a reserved singleton agent that acts as the motel's front desk: its only job is answering questions about the other agents and doing safe fleet management for you — summarize what everyone is doing, find the agent that worked on something (via `am search`), revive exited agents, queue messages, and point you at the right session. In the hub, press `c` (or pick "Ask the concierge" in the `ctrl-k` palette) to jump to it from anywhere; its row is marked `✦ concierge` in cyan, and it is created on first use and revived automatically when its session has exited. It won't stop, interrupt, or remove agents unless you explicitly ask.

There is one concierge per fleet, not per machine: if a concierge already exists on any reachable host, `am concierge` and the `c` key route to it over ssh instead of opening a rival one. Pin its home with `"conciergeHost"` in `~/.agent-manager/config.json` (`"local"` or a host alias — set the same value on every machine to share one front desk), and pick its provider with `"conciergeProvider": "claude" | "codex"` (default `codex`; applies when it's first created).

### Roles

Roles are named instruction presets for agents. They add behavior and a visible identity without changing the provider, model, permissions, or tools. The concierge is a protected built-in role; custom roles live as plain JSON files under `~/.agent-manager/roles/`.

```sh
am role list
am role show concierge
am role add security-reviewer \
  --description "Reviews authentication and data exposure" \
  -m "Review changes for trust-boundary, authentication, and disclosure risks. Report findings; do not implement fixes."
am new auth-audit --role security-reviewer -m "Review the current branch"
am role rm security-reviewer
```

Use `-m -` or `--file <path>` for multiline role instructions, and `--force` to replace an existing custom definition. Selected instructions are snapshotted into agent state, so existing agents keep their role across resume, restore, move, clone, and handoff even if the registry later changes. Role registries are host-local; manage a remote with `am -H <host> role ...` before creating that role there.

The hub shows role tags on agent rows and detail cards. Press `r` to cycle role filters and `s` to cycle status, recent-activity, and role sorting; the command palette exposes the same controls. For scripts, use `am ls --role <name|unassigned>` and `am ls --sort <status|recent|role>`.

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

### Shared artifacts (screenshots, reports)

An agent on a server has no way to show you a file — its paths only resolve there. `am share` publishes the file for the operator instead:

```sh
am share ./screenshot.png "login page after the fix"   # run by the agent (any host)
am files                       # laptop: list shared artifacts across the fleet
am open web-fix                # pull that agent's newest artifact here and open it
am open web-fix 2              # ...or the 2nd newest / `am open web-fix login` by name
```

Shared files are copied to `~/.agent-manager/shared/<agent>/` on the agent's host (so they outlive the worktree), and `am open` pulls them over ssh into `~/.agent-manager/artifacts-cache/` locally. Sharing fires a notification — set `config.notifyCommand` (e.g. a curl to ntfy.sh) on the server so shares from headless hosts reach you.

### Preserve and hand off work

```sh
am transcript api                  # render the conversation as Markdown
am search "rate limit"             # search agent conversations
am handoff api --to codex          # continue with the other provider
am stop api                        # stop but keep resumable state
am resume api                      # restart the same conversation
am rename api api-v2               # rename live or stopped; old name stays an alias
am rm api                          # remove an agent; state remains restorable
am restore api                     # restore a removed agent
am gc                              # preview cleanup (--apply to run it)
```

### Quota headroom

```sh
am usage                           # how much of each provider's quota is left
am usage --json                    # for scripts
am usage --codex                   # one provider
```

```
claude · max
  5h    ██░░░░░░░░░░  13%  resets in 3h16m
  week  █████████░░░  76%  resets in 56m

codex · prolite  (as of 09:54, 8m ago)
  week  ██░░░░░░░░░░  16%  resets in 2d
```

These are the same numbers Claude Code shows under `/usage` and Codex under `/status`, read without touching any agent's pane — checking never interrupts a turn. Limits are per account, so one reading describes the whole fleet no matter how many agents or hosts are running.

Claude's come live from its OAuth API using the credentials `claude` already stored. Codex has no such endpoint, so its figures come from the rate-limit snapshot it writes to its session log on every turn — meaning they are only as fresh as the last codex turn **on this machine**, which is why they carry an "as of" note and are marked stale after 30 minutes.

The hub and picker show a compact version in the key bar (`claude 13%/5h 76%/wk · codex 16%/wk`, `?` marking a stale reading), refreshed once a minute. Set `"showUsage": false` in `~/.agent-manager/config.json` to turn that off and keep the UI entirely offline.

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
- **Status and queues:** Provider hooks update status and deliver queued messages after a turn. A small auto-started daemon streams changes to the hub and HTTP API, but is not required for delivery. Remote hosts push their changes too: the hub holds one `ssh <host> am __events` subscription per remote and refetches on each event, so a cross-machine status change lands in about an ssh round trip; polling stays on as the fallback for hosts whose `am` predates the subscription.
- **Persistence:** Tasks, snapshots, queues, and conversation references live as plain files under `~/.agent-manager/`.
- **Providers:** Claude hooks use generated per-launch settings. Agent Motel installs guarded hooks in `~/.codex/config.toml` for Codex; approve **Trust all and continue** on the first managed launch.

Claude Code Remote Control is enabled by default. Disable it with `--no-remote` for one agent or `"remoteControl": false` in `~/.agent-manager/config.json`.

## Development

```sh
bun test
```
