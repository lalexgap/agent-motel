# Agent Motel for macOS

A small AppKit app for watching an Agent Motel fleet: a sidebar of agents with live status, each agent's chat, and a composer to send it a message. The page is bundled inside the app and served from `am-app://app/`; all server traffic goes through a native bridge that holds the access token. Requires macOS 12.3 or later.

The app can send exactly two kinds of write request: send a message to an agent (`POST /api/agents/:key/messages` with `{text, mode}`, `mode` being `queue` or `now`) and cancel a message that is still queued (`DELETE /api/agents/:key/messages/:id`). Every other request is a `GET`, so the app cannot interrupt, start, stop, rename or remove agents, answer permission prompts or upload files.

## Build

Run `bash macos/build.sh` on a Mac with Xcode Command Line Tools and [Bun](https://bun.sh). It runs the unit tests (navigation policy, connection URL policy, API path validation, message validation and request shape, SSE parser, bundle file resolution), builds the frontend with `bun desktop/build.ts`, copies `desktop/dist` into `Contents/Resources/web`, and produces `macos/build/Agent Motel.app` plus a zip for the build machine's architecture. Set `WEB_DIST` (relative to `macos/`, or absolute) to use an already built frontend instead. Copy the app into `~/Applications` and open it.

## First run

The app opens on the connection form. Enter a name, the server URL (for example `https://am.example.com` or `http://127.0.0.1:8790`) and the access token (`am token` on the server). The app checks `/api/health` with the token before saving. **⌘,** reopens the connection list.

## Security model

- The token is stored in the login Keychain as a generic password (service = the bundle identifier, account = the connection id). It is sent only as an `Authorization: Bearer` header, never logged, never put in a URL, and never returned to the page, which only sees `hasToken`. Changing a connection's URL requires entering the token again.
- The page has no network access: its Content Security Policy sets `connect-src 'none'`, and only bundled scripts run. Every request goes through the bridge, which accepts messages only from the app page's main frame, validates every parameter, and builds request URLs from the saved server plus an `/api/...` path, so the page cannot redirect a request to another host.
- `api.get` only ever sends `GET`. The two write methods take values, not paths: `messages.send` takes an agent (`name` or `host:name`, checked against am's name rules and percent-encoded into one path segment), the text (trimmed, non-empty, at most 100,000 UTF-8 bytes, and free of control characters other than tab and line breaks, since am types it into the agent's pane where Esc or Ctrl-C would act on the agent) and the mode (`queue` or `now`; the server's `interrupt` mode is not reachable), and sends a JSON body of exactly `text` and `mode`. `messages.cancel` takes an agent and a message id and sends a `DELETE` with no body. A send is never retried: after a network failure or timeout (60 seconds for these two) the call fails and the message may or may not have been delivered.
- Requests use an ephemeral session (no cookies, cache or credential storage), time out after 30 seconds (60 for message requests), cap responses at 32 MiB and refuse redirects so the token is never replayed elsewhere.
- Plain `http` is accepted only for localhost, `127.0.0.0/8`, `[::1]`, Tailscale addresses (`100.64.0.0/10`) and `*.ts.net`; anything else must use `https`. URLs with a user name or password are rejected.
- The app is sandboxed with outbound network access only. Only `am-app://app/` pages load in the window; clicked `http(s)` links open in the default browser.

## Shortcuts

**⌘,** connections, **⌘R** refresh (reloads the page if it never finished loading), **⌘F** find, **⌘0** show the window, **⌘W** close it, **⌘M** minimise. Closing the window or quitting leaves server agents running. Set `AM_DEBUG=1` in the environment to enable the Web Inspector. If the page fails to load, a Reload button appears.

## Smoke test

`bash macos/smoke.sh` is an opt-in integration check on a Mac with a logged-in desktop session. It builds the app under a separate bundle id (`ca.alexgap.agent-motel.smoke`, with its own defaults and Keychain items), starts the synthetic fixture server (`bun desktop/fixtures/server.ts --port 8791`) and launches the app in the background without activating it. It saves a connection through the real bridge, checks `/api/health`, a wrong token, rejected API paths, the page's blocked network access and the event stream, rejects invalid messages, sends and cancels a queued message and sends a `now` message (checking the fixture's log of received requests), opens an agent's chat, sends from the composer, queues and cancels a message there, writes a screenshot (`SMOKE_SCREENSHOT`, default in the temp directory), then removes the connection and its Keychain item. The message checks need the fixture server (its `/__fixture/requests` log and its `harbor-lights` and `keeper-log` agents); `smoke.sh` refuses a `SMOKE_URL` that is not on loopback, because the smoke test sends messages. `SMOKE_BRIDGE_ONLY=1` skips the UI steps.

## Signing

Builds use local ad-hoc signing by default. An ad-hoc signature changes with every build, so macOS may ask again for Keychain access to a saved token after you rebuild. Run `bash macos/setup-signing.sh` once to avoid that: it creates a self-signed identity, "Agent Motel Local Signing", in its own keychain (`~/Library/Keychains/agent-motel-signing.keychain-db`), and `build.sh` signs with it whenever that keychain exists. Gatekeeper does not trust it.

The trade-off: the identity's keychain password is in this repository, so any process running as you can sign its own binary with this identity, and that binary passes the Keychain check for saved tokens without a prompt. Setting it up removes the Keychain prompt that otherwise guards your tokens. If that matters, skip `setup-signing.sh` and accept the prompt after every rebuild.

For distribution to other Macs, set `SIGNING_IDENTITY` to your Developer ID Application certificate and notarize the zip with Apple's `notarytool`, then staple the app and repackage it. This repository does not include signing credentials or claim notarized distribution. No automatic updater is included.
