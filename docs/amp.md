# Amp provider

`am new <name> --amp` (or `--provider amp`) runs [Amp](https://ampcode.com)'s TUI (`amp`) in the agent's tmux session. Install Amp and sign in with `amp login` first, and open `amp` once by hand: its first launch shows onboarding screens that an unattended agent can't get past.

## Launch and resume

- **New agent**: `amp --no-ide [-m <mode>]`. Amp has no prompt argument or system-prompt flag, so the am primer and task are piped in on stdin as the first message, the same text Codex gets prepended. Amp reads the terminal for everything after that.
- **Model and effort**: Amp chooses both through its mode. `--effort low|medium|high` picks that mode and `xhigh`/`max`/`ultra` pick `ultra`. `--model <mode>` passes a mode name directly, and any other `--model` is a `provider/name` for Amp's `--model`, with `--effort` passed alongside. `am models --amp` lists the modes.
- **Session ID**: the Amp thread ID (`T-…`), recorded from the plugin's first `session.start`.
- **Resume / restart**: `amp threads continue <T-id>`, or `--last` when no thread was recorded. A message given to resume is queued and delivered by the plugin once the thread is up.
- **Permissions**: Amp doesn't ask for tool approvals by default, so there is no bypass flag to pass and no approval relay.

## The plugin

Amp has no settings-file hooks, so am installs a system plugin at `~/.config/amp/plugins/agent-motel.ts` (source: `src/amp/agent-motel.ts`) whenever it launches or resumes an Amp agent. Amp loads it into every thread on the machine, so it does nothing unless `AGENTMGR_AMP_AGENT` equals `AGENTMGR_AGENT`, which am sets only when it launches an Amp agent. `AGENTMGR_AGENT` alone isn't enough, because a Claude or Codex agent that runs `amp -x` passes it on. For a managed agent, the plugin runs the existing `am hook` commands with Claude-shaped JSON on stdin:

| Amp event | am hook | Notes |
|---|---|---|
| `session.start` | `session-start` | Records the thread ID. |
| `agent.start` | `user-prompt-submit` | `additionalContext` (plan, decisions, operator notes, inbox) is appended to the prompt. |
| `agent.end` | `stop` | A block (`{decision:"block", reason}`) becomes `{action:"continue", userMessage: reason}`, which delivers the inbox at turn end. |
| `tool.call` | `pre-tool-use`, or `subagent-start` for `Task` | |
| `tool.result` | `post-tool-use`, or `subagent-stop` for `Task` | |

Hooks for any thread other than the agent's recorded one are ignored (a launch or resume may adopt a new one). This keeps an `amp -x` run by the agent, which inherits its environment, from reporting as the agent.

## Message delivery

am doesn't type into Amp's TUI. Messages are delivered in two ways:

- **At turn end**, the stop hook's inbox block becomes a `continue` turn. Amp allows 5 consecutive plugin continuations before ignoring more, and any user message resets that count.
- **While idle**, the plugin checks the thread every 3 seconds. When the thread is idle it runs `am hook amp-drain`, which takes the queue under the delivery lock and returns one `[am inbox]` prompt, and the plugin sends that prompt with `appendUserMessage`. Delivery can therefore lag by up to 3 seconds, and costs one short `am` process per idle Amp agent per poll.

`am send --now` (mid-turn steering) is refused for Amp agents.

## Not supported yet

- `am transcript`, `am search` and usage/token reports don't read Amp threads. Use `amp threads markdown <T-id>`. `am peek` works because it reads the pane.
- `am switch-model`. `am restart --model` relaunches with `threads continue`, and the thread keeps its own mode.
- `am handoff` to or from Amp.
- Subagent ledger: Amp 0.0.1792680614 doesn't send a `tool.call` for `Task` itself (only for the tools the subagent runs, under the parent's thread), so `am subagents` stays empty.
- If the operator switches threads inside the TUI, am keeps following the original thread.
