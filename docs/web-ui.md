# Agent Motel front desk

The browser front desk combines a compact dark fleet list, attention filters, agent conversations and an inline concierge. Sort by repository, status, time in the current working state, recent activity or name; reverse any ordering. Create Codex or Claude agents on configured fleet hosts, choose a model and role, send or queue messages, answer permission requests, use interactive terminals, cancel tracked queued messages, and resume, restart, change model, interrupt, stop or remove agents. Destructive controls ask for confirmation. Chat and fleet changes arrive through server-sent events, with four-second polling for recovery and remote transcripts; unreachable hosts and request failures remain visible.

Overview counts exclude the concierge. Available corresponds to CLI `idle`; Stopped includes `exited` and `dead`. The concierge dock shows the provider, host and lifecycle status of the resolved concierge, separately from message acceptance feedback. Missing fleet metadata shows an unknown provider rather than assuming Codex.

The create dialog identifies the host that owns the directory. Git repositories create isolated worktrees when the host's `worktreeByDefault` setting is enabled; otherwise they run in place. Non-Git directories run in place. New branches use origin's default branch when available, then `origin/main` or `origin/master`, otherwise repository HEAD. Creation attempts to fetch the selected origin branch first and uses the saved ref if fetching fails. Existing branches are reused.

Agent details offers **Change model…** for a running agent. Its catalog comes from the agent's host and provider, with provider-default and model-specific reasoning options. Applying a selection restarts the provider, interrupts the current turn, and retains the conversation and queued messages. The dialog uses the configured model and effort; the model shown in details is observed from the last turn and can continue to show the previous value until the agent replies after restarting.

The design takes inspiration from [Linear's attention-first Inbox](https://linear.app/docs/inbox) and [Vercel's overview-to-detail observability](https://vercel.com/docs/observability): quiet navigation, actionable status, and a focused agent workspace. The responsive layout uses local system fonts and no external scripts, analytics or CDN dependencies.

Built-in subagents appear beneath active parents and in agent detail, including finished runs and available output. They are read-only: redirect them through the parent. Running Codex subagent transcripts may only become available at completion. AM child agents link to their parent and retain independent conversations and lifecycle controls. Subagent records use `GET /api/agents/:name/subagents`; select output with `GET /api/agents/:name/transcript?subagent=id`. Remote output requires a remote am version supporting `transcript --json --subagent`.

Opening an agent defaults to its interactive terminal; switch to Chat for the transcript and message composer. The concierge opens in Chat. Terminal output and keystrokes use WebSockets attached to the existing tmux session. Closing a tab, switching views, or signing out disconnects only that terminal client; the agent keeps running. Mobile controls provide Escape, Tab, Ctrl+C, arrow keys and Enter. The sidebar shows live agents by default; “Show stopped” includes exited agents without changing fleet search.

**PRs** lists every pull request the fleet tracks (`GET /api/prs`), needs-you first, then merge-ready, in progress and recently merged or closed. Each row shows the repository, title (linked to GitHub), owning agent and host, a status chip with its one-line reason and how long it has been in that state, last activity and stack position; adjacent members of a stack are drawn as a chain. Filter by repository, state or "Needs me" without refetching, or include older merged and closed PRs. Row actions open the PR, go to the agent, nudge it (opens the agent's chat with a status question prefilled, not sent) and show an open decision's question; the page never answers decisions or writes PR state. The nav badge counts PRs that need you and refreshes with the fleet, and the page says when its data is stale or a host is unreachable. The page is `web/prs.js` (`window.agentPrs`), which takes data and callbacks only, so the desktop app can reuse it.

Install locked dependencies with `bun install --frozen-lockfile` when deploying. xterm.js and its fit addon are served locally from `node_modules`; no asset build or CDN is needed. Remote terminals use configured SSH hosts and an identity-checked `am __terminal` command. Update remote am installations to the same release; older hosts return an upgrade-required message. The remote verifies the expected agent creation timestamp and attaches by immutable tmux session ID. Remote chat currently uses polling; local transcript file changes are pushed.

## Enable

Add these settings to `~/.agent-manager/config.json` (merge with existing settings):

```json
{
  "webOrigin": "https://am.alexgap.ca",
  "conciergeHost": "local",
  "conciergeProvider": "codex",
  "conciergeModel": "gpt-6-luna",
  "conciergeEffort": "low",
  "conciergeAutoStart": true
}
```

Use `am models --json --codex` to verify the selected model is available to your account. Model and effort settings apply to newly created concierges. Existing concierges retain their provider and conversation; switching provider requires archiving the old concierge with `am rm concierge` and creating it again with `am concierge --no-jump`. Removal keeps its archived state/transcript; do not use `--clean`.

Run `am serve --bind 127.0.0.1 --port 8790` under a persistent service. When web mode is enabled, service startup ensures the concierge exists and revives it after a restart. `conciergeAutoStart: false` disables startup creation. Opening the concierge also ensures it is available. A startup error is logged without taking down the dashboard; opening the concierge retries it.

Concierge revival requires a captured conversation ID, including generic CLI and API resume. If it is missing, revival refuses to resume an unrelated recent conversation; archive the old concierge with `am rm concierge` and reopen it with `am concierge`. A live concierge can still be opened before its ID has been captured.

Caddy configuration:

```caddyfile
am.alexgap.ca {
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:8790
}
```

Caddy must be the only public listener. Keep Bun on loopback. Access via the exact configured HTTPS origin; an HTTP origin is rejected. `am token` prints the private access key locally for sign-in. Never put the key in a URL, service log, screenshot or PR. A custom `AM_API_TOKEN` must contain at least 24 high-entropy characters. The automatically generated key has 192 bits of entropy.

## Authentication and security boundaries

The access key grants full fleet control, including code execution by agents. This is a single-owner administration UI, not a multi-user or tenant-isolated application. Do not share the key with someone who should not control the host. Agent permissions and sandbox policy remain those configured in am; the UI adds no sandbox.

The key is exchanged once for a random server-side session. Only a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only cookie reaches the browser; no credential is persisted in localStorage or URLs. Sessions expire after 12 hours and are invalidated by logout or service restart. Sign-in is globally limited to ten attempts per minute, independently of proxy IP headers. This deliberately trades some sign-in availability under attack for bounded guessing; existing sessions keep working. There are at most 100 sessions.

Cookie-authenticated mutations and login/logout require an exact Origin match. The existing bearer API remains compatible and never accepts query-string keys. The browser SSE route and terminal WebSockets require a revocable browser session. WebSocket upgrades require an exact Origin match; same-origin SSE and terminal preflight GETs also accept browser Fetch Metadata when Origin is absent. Logout, replacement login and expiry close attached streams immediately. The existing daemon-event API remains bearer-only. All web assets and authenticated responses are `no-store`, with a restrictive script CSP, frame denial, no-referrer and nosniff. Agent/tool/transcript content is rendered as text, never HTML. Inline styles are allowed for xterm’s dynamic terminal layout; inline scripts and eval remain blocked. Terminal access provides the same full host authority as attaching through SSH. Input/output queues, dimensions and simultaneous terminal connections are bounded. Request bodies are limited to 256 KiB. The old service-worker URL still unregisters obsolete PWA installations.

Rotate the key with `am token --reset`, then restart **every** running `am serve` process: each process captures its key at startup. If using `AM_API_TOKEN`, rotate that environment secret instead. Restarting also revokes browser sessions. Restore the previous service executable/configuration and remove the Caddy site to roll back. With `webOrigin` absent, the server retains its API-only behavior.

## Verification

`bun test tests/webAuth.test.ts tests/webTerminal.test.ts tests/webEvents.test.ts tests/server.test.ts` covers auth, session expiry/revocation, CSRF, rate limiting, body limits, existing bearer clients terminal attachment, resize, disconnect cleanup and chat event delivery. Browser interaction checks should cover login, filters, search, concierge chat, sending, creation narrow-screen layout, terminal typing/reconnect, and logout while a stream is open. UI screenshots made with fixtures must be identified as such; they do not demonstrate a real agent completed a task.

## Answering Claude prompts

Visible Claude question and permission dialogs appear as cards above both Chat and Terminal. Choose an option, or fill in **Other** when the dialog offers a text answer. These answers drive the existing tmux pane; they are not queued chat messages and do not interrupt the turn. Refreshes preserve an unfinished Other answer while the displayed prompt stays unchanged. A changed or already answered prompt is rejected; inspect the refreshed card or use **Open terminal**.

The existing `PermissionRequest` hook relay still handles structured approvals (including Codex app-server approvals). Claude's `AskUserQuestion` can be visible without a usable permission hook, and the hook's bounded wait can expire while the terminal dialog remains. The pane path therefore reads the live screen, recognizes only supported Claude menus, and sends the menu's own navigation and input keys. Transcript tool calls provide conversational context but are not proof that a dialog is still waiting. Notification hooks continue to feed the fleet/sidebar attention state; detail polling detects the visible prompt independently of that state.

`GET /api/agents/:name` includes `panePrompt` when a supported dialog is visible. `POST /api/agents/:name/prompt` accepts `{id, optionId, text?}`. IDs are single-use snapshots bound to agent creation, tmux pane identity/process, and screen contents. The server recaptures the pane and checks the snapshot under a lock before writing; partial input failures require terminal inspection instead of automatic retry. A terminal user can still race pane input, so avoid answering simultaneously in multiple clients. The endpoint uses the existing API authentication and browser Origin checks. Remote answers use `am __prompt-answer` with JSON on stdin; upgrade the remote am installation too.

Detection targets the installed Claude Code 2.1.318 single-select question menus and Bash Yes/No permission menus whose visible pane includes the dialog boundary, `Bash command` header, and a nonempty command body. Other permission types, truncated or ambiguous operation context, checkbox/multi-select menus, preview layouts, active text editors, and clipped layouts use the structured relay or fall back to the web terminal, with live raw pane text available for attention prompts. Codex's existing structured approval cards remain available. Extending pane question cards to Codex requires its own dialog fixtures, navigation rules, and freshness tests; Claude key sequences must not be reused for Codex.
