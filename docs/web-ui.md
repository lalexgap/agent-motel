# Agent Motel front desk

The browser front desk combines a fleet overview, attention filters, agent conversations and a concierge. Create Codex or Claude agents on configured fleet hosts, choose a model and role, send or queue messages, answer permission requests, inspect live terminal output, cancel tracked queued messages, and resume, restart, interrupt, stop or remove agents. Destructive controls ask for confirmation. Status refreshes every four seconds while the tab is visible; unreachable hosts and request failures remain visible.

The design takes inspiration from [Linear's attention-first Inbox](https://linear.app/docs/inbox) and [Vercel's overview-to-detail observability](https://vercel.com/docs/observability): quiet navigation, actionable status, and a dedicated conversation instead of a wall of terminals. The responsive layout uses local system fonts and no external scripts, analytics or CDN dependencies.

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

Cookie-authenticated mutations and login/logout require an exact Origin match. The existing bearer API remains compatible and never accepts query-string keys. All web assets and authenticated responses are `no-store`, with a restrictive CSP, frame denial, no-referrer and nosniff. Agent/tool/transcript content is rendered as text, never HTML. Request bodies are limited to 256 KiB. The old service-worker URL still unregisters obsolete PWA installations.

Rotate the key with `am token --reset`, then restart **every** running `am serve` process: each process captures its key at startup. If using `AM_API_TOKEN`, rotate that environment secret instead. Restarting also revokes browser sessions. Restore the previous service executable/configuration and remove the Caddy site to roll back. With `webOrigin` absent, the server retains its API-only behavior.

## Verification

`bun test tests/webAuth.test.ts tests/server.test.ts tests/concierge.test.ts` covers auth, session expiry/revocation, CSRF, rate limiting, body limits, existing bearer clients and concierge options. Browser interaction checks should cover login, filters, search, concierge chat, sending, creation and narrow-screen layout. UI screenshots made with fixtures must be identified as such; they do not demonstrate a real agent completed a task.
