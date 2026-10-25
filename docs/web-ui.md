# Agent Motel front desk

The browser front desk combines a compact dark fleet list, attention filters, agent conversations and an inline concierge. Sort by repository, status, time in the current working state, recent activity or name; reverse any ordering. Create Codex or Claude agents on configured fleet hosts, choose a model and role, send or queue messages, answer permission requests, use interactive terminals, cancel tracked queued messages, and resume, restart, interrupt, stop or remove agents. Destructive controls ask for confirmation. Chat and fleet changes arrive through server-sent events, with four-second polling for recovery and remote transcripts; unreachable hosts and request failures remain visible.

The design takes inspiration from [Linear's attention-first Inbox](https://linear.app/docs/inbox) and [Vercel's overview-to-detail observability](https://vercel.com/docs/observability): quiet navigation, actionable status, and a focused agent workspace. The responsive layout uses local system fonts and no external scripts, analytics or CDN dependencies.

Built-in subagents appear beneath active parents and in agent detail, including finished runs and available output. They are read-only: redirect them through the parent. Running Codex subagent transcripts may only become available at completion. AM child agents link to their parent and retain independent conversations and lifecycle controls. Subagent records use `GET /api/agents/:name/subagents`; select output with `GET /api/agents/:name/transcript?subagent=id`. Remote output requires a remote am version supporting `transcript --json --subagent`.

Opening an agent defaults to its interactive terminal; switch to Chat for the transcript and message composer. The concierge opens in Chat. Terminal output and keystrokes use WebSockets attached to the existing tmux session. Closing a tab, switching views, or signing out disconnects only that terminal client; the agent keeps running. Mobile controls provide Escape, Tab, Ctrl+C, arrow keys and Enter. The sidebar shows live agents by default; “Show stopped” includes exited agents without changing fleet search.

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
