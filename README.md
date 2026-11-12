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

The full-screen hub shows every agent in a sidebar with a live preview of the selected session. Use it to switch agents, check progress, send follow-ups, or let agents collaborate across machines. Press `Ctrl-K` for a searchable command palette (`Ctrl-P` remains a legacy alias).

## Install

Requires [Bun](https://bun.sh), tmux, and at least one supported agent CLI (new agents default to Codex — see [Create and navigate](#create-and-navigate) to change that):

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://developers.openai.com/codex/cli) 0.133 or newer

```sh
git clone https://github.com/lalexgap/agent-motel.git
cd agent-motel
bun install
bun link
```

## Quick start

For a native desktop client, see [Agent Motel for macOS](macos/README.md).

```sh
am new api-refactor -m "refactor the API layer"  # create and attach
am new bugfix --dir ~/code/other-repo            # use another repo
am new claude-take --claude --no-jump            # use Claude Code, stay in the hub

am                         # open the hub
am ls                      # list agents (--json; --role/--sort for scripts)
am summary                 # prioritized attention/active/idle fleet report
am prs                     # every PR agents own, by who has to act next
am usage                   # quota headroom for claude and codex
am j api                   # jump by name prefix
am -                       # return to the previous agent
```

Agents created in a git repository get a worktree on `am/<name>`. New branches start from a freshly fetched `origin/main` (origin's default branch), not the current checkout; pass `--base <ref>` (e.g. `--base HEAD`) to start elsewhere. Pass `--in-place` to use the current checkout or `--worktree <branch>` to choose a branch.

For help, start with the [troubleshooting index](docs/troubleshooting.md),
[web setup](docs/web-ui.md), or [remote setup](#remote-fleets).
Integration details are in the [HTTP API reference](#http-api).

## Common commands

### Create and navigate

```sh
am new <name> -m "task"                 # create an agent
am new <name> -m "task" --role auditor  # apply custom instructions
am new <name> --resume [session-id]     # adopt an existing conversation
am run <name> -m "task"                # create, wait, and print the answer
am pick                                 # open the classic picker
am peek <name>                          # print the current screen
```

Agents run on Codex by default. `--claude` or `--codex` picks the provider for one agent; `"defaultProvider": "claude" | "codex"` in `~/.agent-manager/config.json` changes the default for all of them.

In the hub, use `↑`/`↓` or `j`/`k` to select an agent, `Enter` or `→` to control it, `ctrl-q` to return to the sidebar, `ctrl-n` to create an agent, `r` to filter by role, `s` to cycle status/recent/role sorting, and `Esc` to detach. Inside an attached session, `ctrl-q` returns to the hub without stopping the agent.

### In-session subagents

Agents also fan work out to their own built-in subagents (Claude Code's Task tool, Codex's subagents). Those run inside the parent session, so they have no pane to attach to — but both providers report them through hooks, and `am` records what ran:

```sh
am subagents                       # what is running right now on this host
am subagents api                   # api's subagents, running ones first
am transcript api --subagent Explore  # read one subagent's side-chain
```

While they run, the hub nests them under their agent, labelled by what they were asked when the provider says (`⤷ Shepherd PR 74`, else `⤷ Explore`) — select one and the right pane follows its output, which is what `am peek <name> --subagent <id|type> --follow` prints in a shell — and `am ls` shows the rollup on the parent's status (`working · 2 subagents · Explore`). An agent back at its prompt while background subagents still run is shown as `working · waiting on 2 subagents (Shepherd PR 74, reviewer)` everywhere a status is shown; its stored status stays idle, so a queued `am send` still reaches it at once (`rawStatus` and `busyWith` in `am ls --json` carry both). If a subagent finishes or goes silent and the agent doesn't resume within ten minutes, it is flagged `needs-attention` instead of sitting idle. They can't be messaged, interrupted, or attached to, and they die with the session that spawned them (most with the turn — a forked/background one runs on until it finishes) — use `am run` for work you need to steer.

Agents delegate this way by default: an implementor or a reviewer an agent needs is a subagent, and it spawns another am agent only when you explicitly ask for one. The fleet stays a flat list of things you asked for, each fanning out in-session.

### Models and reasoning effort

```sh
am models                               # what claude and codex offer here
am models --json --codex                # machine-readable, one provider
am -H server models                     # ask another machine
am new deep-dive --codex --model gpt-5.6-sol --effort ultra
```

Model and effort options come from the installed CLIs rather than a hardcoded list: codex reports its own catalog (including which reasoning levels each model supports — `ultra` exists only on the newest), and claude's levels are read from its `--help`, so new ones appear as soon as you upgrade. The hub's create form cycles the real options with `←`/`→` — for the machine the agent will run on, so a remote host's catalog is used when you pick it as the location — and the model field still accepts a typed name. `am new` / `am run` reject a `--model` or `--effort` the provider can't accept instead of spawning a session that dies on startup; claude's model list isn't exhaustive, so an unrecognized model there is only a warning.

A rejected nickname such as `astra` gets a “did you mean” hint only when it uniquely matches a full slug suffix in that machine's catalog. Pass the exact suggested slug; AM never silently selects it or chooses between ambiguous matches.

#### Agents switching their own model

```sh
am switch-model sonnet --reason "simple rename, no design work"   # run by the agent itself
```

A Claude or Codex agent can move itself to a cheaper or stronger model early on. `am switch-model` validates the choice like `am restart --model`, but refuses a model `am models` does not list, and records it; when the agent's turn ends with no background work still running, the am daemon restarts it on that model, resuming the same conversation with a prompt to continue (queued messages wait for the new session). A switch re-reads the whole conversation without the provider's prompt cache, so it is allowed only during the agent's first `selfModelSwitchMaxTurns` turns (default 2; `0` disables the command and its system-prompt hint), once per agent, and only for agents `am new` started on a fresh conversation. If the switch fails, the agent stays on its model and is told so. The lifecycle audit records each switch with its reason. Operators keep using `am restart <name> --model`.

### Fleet concierge

```sh
am concierge                                  # open the fleet assistant
am concierge which agent touched the auth flow?
```

`concierge` is a reserved singleton agent that acts as the motel's front desk: its only job is answering questions about the other agents and doing safe fleet management for you — summarize what everyone is doing, find the agent that worked on something (via `am search`), revive exited agents, queue messages, and point you at the right session. In the hub, press `c` (or pick "Ask the concierge" in the `Ctrl-K` palette) to jump to it from anywhere; its row is marked `✦ concierge` in cyan, and it is created on first use and revived automatically when its session has exited. It won't stop, interrupt, or remove agents unless you explicitly ask.

There is one concierge per fleet, not per machine: if a concierge already exists on any reachable host, `am concierge` and the `c` key route to it over ssh instead of opening a rival one. Pin its home with `"conciergeHost"` in `~/.agent-manager/config.json` (`"local"` or a host alias — set the same value on every machine to share one front desk), and pick its provider with `"conciergeProvider": "claude" | "codex"` (default `codex`; applies when it's first created).

### Roles

AM registry roles are named instruction presets selected with `am new --role`. `am role list` shows this host-local registry; it does not enumerate native subagent presets. They add behavior and a visible identity without changing the provider, permissions, or tools. Each role can also pin the provider it launches on and set a default model for each provider. `caretaker` and `concierge` are protected built-in roles; custom roles live as plain JSON files under `~/.agent-manager/roles/`.

```sh
am role list
am role show concierge
am role add security-reviewer \
  --description "Reviews authentication and data exposure" \
  -m "Review changes for trust-boundary, authentication, and disclosure risks. Report findings; do not implement fixes."
am new auth-audit --role security-reviewer -m "Review the current branch"
am role model security-reviewer --claude --model opus
am role model security-reviewer --codex --model gpt-5.6-luna
am role model security-reviewer --codex --clear
am role provider security-reviewer --claude   # always launch this role on claude
am role provider security-reviewer --clear
am role rm security-reviewer
```

Provider pins and model defaults apply to newly launched agents, including launches from the hub and `am run`. An explicit `--claude`/`--codex` overrides the pin and an explicit `--model` overrides the model default; without either, the config default provider and the provider's own default model apply. Use `am role show <name>` to inspect defaults. Model defaults can also be set on built-in roles, and replacing role instructions with `--force` preserves them.

Use `-m -` or `--file <path>` for multiline role instructions, and `--force` to replace an existing custom definition. Selected instructions are snapshotted into agent state, so existing agents keep their role across resume, restore, move, clone, and handoff even if the registry later changes. Role registries are host-local; manage a remote with `am -H <host> role ...` before creating that role there.

#### Roles as the providers' own subagents

Agents delegate to built-in subagents, and both providers let you define those by file — so am writes its roles there too. Three native subagent presets ship with am (not AM registry entries unless you add custom roles with those names): `engineer` (implements a settled brief and reports once; Opus 5.5 / gpt-5.6-sol at medium effort), `reviewer` (severity-tagged findings and a `Verdict:` line, never edits; Opus 5.5 / gpt-5.6-sol at high effort), and `shepherd` (takes a PR to merge-ready with the shepherd-pr skill, never merges; Opus 5.5 / gpt-5.6-luna at medium effort). Every custom role is exported alongside them, and a custom role with a shipped name replaces it.

```sh
am role export             # ~/.claude/agents/<name>.md and ~/.codex/agents/<name>.toml
am role export --dry-run   # show what would change
```

The export also runs after every role edit and on every `am new`, so the files track the registry. am only ever rewrites files it wrote itself: one you authored, or edited after am wrote it, is kept and reported. Claude picks a subagent by its type ("use the reviewer agent"), Codex by its `name` — the same words in an am-managed session or your own.

Subagents never get the parent's [plan file](#plan-file) injected; when one needs it, the parent passes the plan path in the subagent's brief.

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

Shared files are copied to `~/.agent-manager/shared/<agent>/` on the agent's host (so they outlive the worktree), and `am open` pulls them over ssh into `~/.agent-manager/artifacts-cache/` locally. Sharing fires a notification, which the daemon on your laptop relays from remote hosts (see [Remote fleets](#remote-fleets)); `config.notifyCommand` (e.g. a curl to ntfy.sh) adds another channel such as phone push.

### Preserve and hand off work

```sh
am transcript api                  # render the conversation as Markdown
am search "rate limit"             # search agent conversations
am handoff api --to codex          # continue with the other provider
am stop api                        # stop but keep resumable state
am resume api                      # resume an exited agent
am restart api                     # reload Claude/Codex and resume the same conversation
am rename api api-v2               # rename live or stopped; old name stays an alias
am rm api                          # remove an agent; state remains restorable
am restore api                     # restore a removed agent
am gc                              # preview cleanup (--apply to run it)
am gc --auto status                # the scheduled cleanup: last run, next run
am gc --restore my-worktree        # recreate a worktree gc removed
```

Restart an agent from the sidebar by selecting it and pressing `e`, then `s`, or choosing **Restart** in the command palette. Restart interrupts its current turn and loads the installed provider binary; update Claude/Codex first to pick up a newer version. The conversation, working directory, and queued messages are preserved.

### Cleanup

The daemon runs the cleanup on its own, nightly at 04:00 (or at the next moment no agent is working, after a missed night). It applies the same policy as `am gc --apply`. After an upgrade it only reports, over as many runs as it takes to look at every worktree once, and starts removing after that; check `am gc --auto status` to see what it would take. `am summary` ends with the last run ("gc: freed 12 worktrees (9.1 GB); kept 3 dirty").

A worktree that a registered agent owns is never removed, running or exited. An agent owns its `dir` and worktree, the worktree named after it, and any managed worktree its session has worked in that no other agent (or restorable agent still holding it) is registered in. The others go as follows (the ages are `gc*` keys in `~/.agent-manager/config.json`):

| What | When | Key |
| --- | --- | --- |
| Exited agent, untouched | reaped to trash after 7 days | `gcAgentDays` |
| Exited agent whose tracked pull requests all merged | reaped to trash 3 days after the merge, and its worktree released | `gcMergedDays` |
| Worktree of a removed (`am rm`) or reaped agent | released after 7 days; `am restore` recreates it from its branch | `gcRemovedDays` |
| Worktree no agent owns, and subagent worktrees under `.claude/worktrees/` | after 3 days without activity | `gcOrphanDays` |
| Released worktree that is dirty or has unpushed commits | kept until unchanged for 30 days; then its changes, and its small ignored files, are committed to `refs/am-gc/<name>-<time>-<id>` in the repository and it is removed (`0` keeps these forever) | `gcStaleDays` |
| Released worktree whose only leftovers are git-ignored files (env files, keys, `node_modules`) | after 7 days unchanged; ignored files of up to 1 MiB each (50 MiB in all) are saved to a ref as above, while `node_modules`, directories of more than 5,000 entries and larger files are not, and the log lists what was left out (`0`: treated like any other change) | `gcIgnoredDays` |
| Trash snapshots | purged after 30 days | `gcTrashDays` |
| Handoff transcripts, cached shared files | after 30 days | `gcFileDays` |

Conversations, plans and inbox files stay for as long as the agent is registered or in trash. A file named `.am-gc-keep` in a worktree keeps it (and the subagent worktrees inside it) whatever its state. A worktree with an active dev-pool lease is never touched.

The scheduled run is throttled: it runs at the lowest CPU and IO priority, inspects one worktree at a time, backs off while the host is busy, stops after `gcAutoMaxMinutes` (15) and continues the next time. Busy means the 1-minute load per CPU is above `gcAutoMaxLoad` (default 1) or Linux IO/memory pressure is above `gcAutoMaxPressure` (default 20). Only one gc runs at a time, manual or scheduled. `am gc --auto pause` stops the schedule and `resume` restarts it; `gcAuto: false` turns it off; `am gc --auto run` starts a sweep now.

Every removal is logged to `~/.agent-manager/logs/gc.jsonl` with the worktree's branch and commit. `am gc --restore <name-or-path>` recreates a removed worktree from that log and puts salvaged changes and ignored files back as uncommitted files. A worktree holding a nested repository or submodule is never removed.

### Plan file

Every agent keeps one running plan, so you always have a current doc of what it is working on:

```sh
am plan api             # print it
am plan api --path      # just the path (~/.agent-manager/plans/api.md)
am plan api --json      # {name, path, exists, updatedAt, content}
```

`am new` writes it from a short template holding the task (Goal, Current status, Next steps, Decisions, Notes); the agent keeps it current. Its first 80 lines (6 KB at most) are injected into the agent's context once per session (at startup, resume, compaction and `/clear`), on the next prompt rather than every turn or tool call, so it costs a few hundred tokens per session. When a turn of five minutes or more ends without the plan changing, the next prompt carries a one-line nudge. The plan follows the agent through rename, move, `am rm`/`am restore` (it goes to trash with the state), and `am handoff` (the new agent inherits it). Agents created before plans existed get one on their next resume. The concierge and caretaker get none; skip one with `am new --no-plan`, or turn plans off with `"plans": false` in `~/.agent-manager/config.json`. `am ls --json` includes each local agent's `planFile`.

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

Notifications follow you too: each host journals its notifications (`am notifications` lists them), and the daemon on any machine with a notifier long-polls every remote's journal and shows them locally, labelled with the host — so agents on a headless server reach your laptop's desktop. Anything that piled up while the laptop slept arrives as one summary. Set `relayNotifications: false` to opt out.

## Web front desk

A responsive dashboard for monitoring the fleet, chatting with agents and the concierge, creating agents, answering permission requests, changing a running agent's configured model, and managing sessions. Enable it with an HTTPS `webOrigin`; sign in with `am token`. The concierge can start automatically with the service, including after a reboot. See [setup, authentication and deployment](docs/web-ui.md). In the browser, `Ctrl-K` (or `Cmd-K`) opens Overview and focuses its list filter; the terminal hub's `Ctrl-K` opens commands.

## HTTP API

<details>
<summary>Integration reference: endpoints, receipts and permissions</summary>

```sh
am serve
am token
```

The token-protected API can list, message, interrupt, create, stop, restart, and resume agents, read their parsed transcripts (`GET /api/agents/:name/transcript`, indexed turns; the same object as `am transcript <name> --json`), with live fleet updates at `/api/events`. `POST /api/agents/:name/messages` (`{text, mode: queue|now|interrupt}`) returns a message `id` (also printed by `am send ... --json`), and `DELETE /api/agents/:name/messages/:id` cancels it while it is still queued (409 once it has been delivered). `POST /api/agents/:name/interrupt` (`{text?}`) presses Esc and then sends `text` if given; neither provider fires a Stop hook for a turn aborted with Esc alone, so am waits a few seconds for the pane to return to an empty prompt, then marks the agent idle and delivers what is queued. 409s from the message and interrupt routes carry a machine-readable `reason` beside `error`: `not_delivered`, `already_done`, `already_cancelled`, `already_failed`, `already_delivered`, `no_session`, `mailbox_busy`, `remote_too_old`, or `unknown`. `POST /api/agents/:name/stop` and `/restart` act unconditionally and reject an `ifIdle` field (and `/restart` a `model` or `effort`) with 400, since a conditional stop is CLI-only: `am stop <name> --if-idle` stops only an agent that is idle with nothing queued and no delivered message still in its turn, and otherwise prints `{ok: false, reason: busy|queued|in_turn}`. Agents launched with prompts (`skipPermissions: false`) can have their permission prompts answered over the API too: `GET /api/agents/:name/permissions` lists the pending ones (`{requests: [{id, provider, tool, summary, input, options: [{id, label, kind: allow|deny|allow_always}], createdAt, expiresAt}]}`), and `POST /api/agents/:name/permissions/:id` with `{optionId}` answers one with one of its own options (200 once the provider has the decision; 409 with `reason` `expired`, `already_resolved` or `not_pending`; 404 for an unknown id). The daemon's event stream emits `permission-request` and `permission-resolved`, and agent detail reports `permissionRequests` and `pendingPermissions`. For Claude, a `PermissionRequest` hook relays the prompt while Claude's own dialog stays on screen: it waits `permissionWaitSeconds` (default 120, 0 turns it off) for an answer, and otherwise steps aside, leaving the pane prompt as the only way to answer. A prompt answered in the pane, or a turn that ends, retires the request. For daemon-attached Codex agents, the am daemon joins each thread on the app-server and sees its command and file-change approvals; they have no deadline, and the first answer from either side wins. Options are the provider's own: an "always" choice is persisted only by the provider itself. It drives agents on other fleet hosts too, over the same ssh as `am -H`: address one as `host:name` in `/api/agents/:name/...`, pass `host` (and optionally `remoteDir`; otherwise a `dir` under `$HOME` maps to the remote `$HOME`) to `POST /api/agents`, and list hosts with `GET /api/hosts`. It can execute code through spawned agents, so keep it on loopback or behind a private network such as [Tailscale](https://tailscale.com). For public browser access, use the HTTPS web mode and authentication described in [web setup](docs/web-ui.md); never expose the Bun listener directly. For systemd deployment, use the [service ownership and migration guide](docs/service-lifecycle.md) and the separate tmux, daemon, and frontend units.

Change a configured model with `POST /api/agents/:name/model`, passing required `model: string|null`, `createdAt`, and `status` from the current agent detail plus optional `effort: string|null`. Null selects the provider default; omitting effort preserves its configured value. The selection is validated before restart, and the request is rejected if the agent stopped, changed status, or was replaced after the detail was read. On success the current turn is interrupted, and the conversation and queued messages are retained. The existing `/restart` endpoint continues to reject model and effort fields.

</details>

## How it works

- **Sessions:** Each agent runs in a detached tmux session, so it keeps working when you leave.
- **Status and queues:** Provider hooks update status and deliver queued messages after a turn. A small auto-started daemon streams changes to the hub and HTTP API, but is not required for delivery. Remote hosts push their changes too: the hub holds one `ssh <host> am __events` subscription per remote and refetches on each event, so a cross-machine status change lands in about an ssh round trip; polling stays on as the fallback for hosts whose `am` predates the subscription.
- **Persistence:** Tasks, snapshots, queues, and conversation references live as plain files under `~/.agent-manager/`.
- **Providers:** Claude hooks use generated per-launch settings. Agent Motel installs guarded hooks in `~/.codex/config.toml` for Codex; approve **Trust all and continue** on the first managed launch.
- **Folder trust:** A new Claude agent's folder (its git root, the main checkout for a worktree) is marked trusted in `~/.claude.json` unless that folder already has an answer (never `~` or above, and only with `skipPermissions` on), so the agent doesn't stall at Claude's trust prompt. am writes under Claude Code's own config lock, records what it wrote in `~/.agent-manager/claude-trusted-dirs.json`, and `am gc` removes only those entries, once their folder is gone. The trust otherwise stays, since you may rely on it (a worktree agent trusts your main checkout). Opt out with `"pretrustClaudeDirs": false`. A Claude agent left at the prompt shows as `needs-attention`.
- **Subagents:** `SubagentStart`/`SubagentStop` hooks append to a per-agent ledger in `~/.agent-manager/subagents/`; a turn boundary closes anything an interrupted turn left open. Claude Code gives each subagent its own transcript next to the parent's (`<session-id>/subagents/agent-<id>.jsonl`), which is where live activity and `--subagent` renders come from; codex reports a subagent's transcript only once it stops.

Remote control is enabled by default. Claude agents launch with Claude Code Remote Control; codex agents attach to the machine's Codex app-server daemon (`codex --remote unix://`, started if needed), which makes them reachable through Codex remote control. A daemon-attached codex agent's turn runs in the daemon, so `am stop`/`rm`/`restart`/`move` also interrupt it there. Disable it with `--no-remote` for one agent or `"remoteControl": false` in `~/.agent-manager/config.json`; codex agents keep the mode they were created with across resumes.

## Development

```sh
python3 scripts/test-isolated.py
python3 scripts/test-isolated.py tests/catalog.test.ts
```

The isolated runner accepts Bun test arguments and uses a private HOME, state directory and tmux socket, with provider stubs. Use it on live-fleet hosts; see [isolated tests](docs/troubleshooting.md#isolated-tests).

## Caretaker

`am caretaker` opens a Codex agent dedicated to finding unused worktrees and agents that may be ready to retire. `am caretaker --scan` requests an inspection-only pass without attaching; a busy caretaker skips scheduled scans instead of accumulating a backlog. Use `am -H host caretaker` to inspect another machine. It is one local agent per host, separate from the fleet concierge.

The caretaker reports exact targets, recent activity, queued work, subagents, worktree ownership, dirty files and merge status. It asks before stopping **any** agent or removing **any** workspace. Long runtime or idleness alone is not evidence of abandonment. After specific approval it rechecks the target and uses conditional idle stops or ordinary (non-forced) worktree removal, preserving conversations and branches. It never runs broad garbage collection or force cleanup. These are agent instructions, not an OS sandbox; am's configured provider permissions still apply.

Set `caretakerModel` and `caretakerEffort` in `~/.agent-manager/config.json` for a newly created caretaker (for example, an available fast Codex model with `low` effort). Scheduled scans never carry forward cleanup approval. Review proposals in `am j caretaker`, its web conversation, or `am transcript caretaker`.

For optional daily inspection at roughly 10:00 local time, install [the service](docs/am-caretaker.service) and [timer](docs/am-caretaker.timer) in `~/.config/systemd/user/`, then run `systemctl --user daemon-reload` and `systemctl --user enable --now am-caretaker.timer`. Disable scheduling with `systemctl --user disable --now am-caretaker.timer`; this does not stop the agent or delete its conversation. No timer is installed automatically. The scan service uses `KillMode=process` so ending the submission command does not kill its managed tmux/daemon children; stop those with am, not by stopping the scan unit. Revival requires a captured session ID and never falls back to another home-directory conversation.

Lifecycle stop requests and outcomes are recorded separately from daemon output. See [inspecting the lifecycle audit trail](docs/lifecycle-audit.md) for attribution, filtering and retention.

## Antigravity / Gemini 4 Argon

Use `am new <name> --antigravity --model gemini-4-argon-high -m "task"` for the native
`agy` provider. Install and sign in to Antigravity separately on the launch host.
Existing Claude/Codex defaults are unchanged. See [Antigravity support](docs/antigravity.md)
for model discovery, exact conversation resume, permissions, unsupported capabilities,
and the authenticated validation steps that remain pending.
