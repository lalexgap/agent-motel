# An iOS app for `am` — research & design exploration

**Status (historical):** the PWA described below shipped and was later
**removed** (PR #30) — `am serve` now exposes only the token-gated HTTP API,
which native/scripted clients consume. The PWA sections stay as design
rationale; the security model (§4e–4f network gating, bearer token) still
describes the live API.

**Audience:** whoever picks this up next (likely a coding agent). Verify the
code references against the current tree; line numbers drift.

---

## 1. What `am` is today (the constraints we're designing against)

- A Bun/TypeScript CLI. Each agent is a real interactive `claude`/`codex`
  process in a detached **tmux** session named `agentmgr-<name>`.
- **State is flat files** under `~/.agent-manager/`: `agents/<name>.json`
  (status, dir, provider, sessionId, task, timestamps), `queue/<name>.jsonl`
  (pending messages), `config.json`.
- A small **daemon** (`src/daemon.ts`) serves **HTTP over a unix socket** at
  `~/.agent-manager/daemon.sock`. It is an accelerator, not a requirement —
  hooks fall back to handling delivery when it's down.
- **Cross-machine fleet**: `remotes` in `config.json` lists ssh hosts; their
  agents are pulled via `ssh <host> am ls --json --local-only` and merged into
  one view (`src/fleet.ts`). `am move` migrates an agent (state + queue +
  conversation file) between machines over ssh + scp.
- **Two existing remote-access paths already work** (see
  `docs/remote-server-plan.md`):
  1. `ssh -t server am` renders the full TUI hub in any terminal.
  2. **Claude Code Remote Control** is on by default (`remoteControl: true`).
     Every agent already appears in **claude.ai/code and the official Claude
     mobile app** and can be driven from there — outbound HTTPS only, no
     inbound ports.

### The single most important design fact

**The official Claude mobile app already lets you prompt and steer individual
agents from your phone, for free, with zero networking work.** Remote Control
gives you: the session list, live streaming output, sending prompts, approving
permission prompts. For *Claude* agents, the "talk to one agent from my couch"
problem is largely solved upstream.

That means a custom iOS app should **not** try to re-implement a terminal or a
chat-with-one-agent view. Its unique value is the layer Remote Control has no
concept of: **the fleet** — many agents across many machines, am-specific
lifecycle operations, and Codex agents (which aren't in Anthropic's app at all).

This reframing drives everything below.

---

## 2. What an iOS app should do

Ranked by how much unique value it adds *over what the Claude app already gives
you*.

### Tier 1 — the reason to build it (fleet awareness)
- **Unified fleet view.** One glance: every agent across every machine, with
  status icon, host badge, provider, queue depth, dir, and "updated Ns ago" —
  exactly what `am ls` / the hub sidebar show, but on a phone. This is the
  killer feature; nothing else surfaces local + remote + Codex in one list.
- **Status at a glance + push notifications.** The whole point of `am` is
  *"which agent needs me right now?"* The statuses already exist:
  `starting · idle · working · waiting · needs-attention · exited · dead`
  (`src/commands/ls.ts`, `STATUS_ICONS`). The app's job is to push
  **`needs-attention`** (permission prompts) and **idle-after-real-work** to
  your lock screen, with the same filtering `am` already does
  (`shouldNotifyIdle` in `src/config.ts`: skip if attached, skip if a queued
  message is about to deliver, skip stints under `idleNotifyMinSeconds`).
- **Send / queue / interrupt from the phone.** `am send` (queue, delivered on
  idle), `am send --now` (steer current turn), `am interrupt` (Esc then send).
  A one-tap "reply" from a notification is the highest-value interaction.

### Tier 2 — fleet lifecycle (am-specific, not in any other app)
- **Spawn** (`am new <name> [-m task] [--dir|--worktree] [--codex]`).
- **Stop / resume / rm** an agent.
- **Move** an agent between machines (`am move <name> <host>`) and **handoff**
  to the other provider (`am handoff`).
- **Per-agent detail**: task, dir, worktree branch, provider, created/updated,
  pending queue (with clear).

### Tier 3 — "jump in" (where native hits its ceiling)
- **Live screen peek.** The hub previews `tmux capture-pane` every second.
  A read-only pane snapshot on the phone is feasible and cheap.
- **Full interactive attach** is where iOS fights you. Three honest options:
  1. **Deep-link into the Claude app** for Claude agents (Remote Control already
     does the hard part) — best UX, zero terminal code, Claude-only.
  2. **Embed an SSH/mosh terminal** (e.g. SwiftTerm) that runs `ssh -t host
     'am j <name>'`. Works for Codex too, but you're now shipping a terminal
     emulator and fighting tmux + an iOS soft keyboard. Heavy.
  3. **Don't.** Peek + send/queue covers ~90% of phone moments; leave true
     attach to a laptop. Recommended for the MVP.

### Explicit non-goals
- Re-implementing the TUI hub or a tmux terminal as the primary surface.
- Re-implementing chat-with-one-Claude-agent — defer to the Claude app.
- A public web dashboard (`remote-server-plan.md` already lists this out of
  scope; the fleet API we design below could feed one later, but don't lead
  with it).

---

## 3. Feasibility

### 3a. Native vs PWA vs wrapper

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Native SwiftUI** | Real push (APNs/critical alerts), backgrounding, Shortcuts/widgets/Live Activities, keychain, best SSH/terminal libs | Swift codebase to maintain; Apple Developer Program ($99/yr); TestFlight/App Store dance | **Best for the real product** |
| **PWA (installable web app)** | One codebase, instant deploy, **no Apple account, no App Store, no re-signing**, trivial to host behind tailscale/Caddy; can do the full interactive fleet API (it's just HTTP) | Web Push on iOS is weak — **but irrelevant here, because push is offloaded to ntfy, not the PWA.** No native SSH (deferred anyway). | **The $0 path — recommended for personal use (pair with ntfy for push)** |
| **Wrap an existing tool** | The Claude app already *is* a high-quality wrapper for the per-agent case | Covers one agent at a time, Claude-only, no fleet/Codex/am-lifecycle | **Use it, don't rebuild it — deep-link to it** |
| **ntfy.sh (off-the-shelf push)** | `notifyCommand` already supports it (`curl ntfy.sh/<topic>`); the ntfy iOS app gives lock-screen push **today, zero code**; supports **action buttons that fire HTTP requests** (tap-to-queue-reply from the lock screen) | Generic notification list, no fleet view | **The push half of the $0 stack — ship first** |

**Recommendation (personal use, paying optional):** the **$0 stack is
PWA + ntfy** — a PWA serves the fleet UI/reply (no Apple account, no App Store,
no weekly re-signing), and ntfy carries push. Earlier I called PWA push "weak";
that no longer bites because the PWA never does push — **ntfy does**. Go native
SwiftUI *only* when you want the polish (integrated push + notification
quick-reply, embedded SSH attach, no rebuild treadmill), at which point the
$99/yr is worth it.

### 3b. Cost decision (personal use) — you don't need to pay

Decided: **prefer not to pay; pay only if it clearly helps.** Given that, the
$99/yr Apple Developer Program is **not required for the MVP**, because:

- The only free-tier blocker that matters for a notify-first tool is **push from
  your own app** (APNs needs the paid program). But **push is offloaded to
  ntfy** — a separate App Store app with its own push pipeline — so your app
  never needs the entitlement.
- That leaves two free paths:
  - **PWA + ntfy (recommended):** $0, no Apple account, no App Store, **no
    7-day re-signing**. The PWA does the fleet UI + reply; ntfy does push
    (with action buttons for lock-screen quick-reply). Covers the entire MVP.
  - **Free native build (personal team):** Xcode sideloads a native app with
    just a free Apple ID — but builds **expire after 7 days** (replug into
    Xcode and rebuild weekly). Annoying for something you rely on for alerts.
- **Pay the $99/yr only when** you want: a polished native app (integrated push
  + notification quick-reply, no rebuild treadmill), embedded SSH terminal
  attach with good UX, or TestFlight's 90-day OTA builds. None are MVP.

### 3c. App Store / distribution constraints (if you do go native later)

- This is a **single-user personal tool**, so it does **not need to ship on the
  public App Store.** That sidesteps most review friction (no "minimum
  functionality" rejections, no privacy-nutrition debates, no demo account for
  reviewers).
- **TestFlight is the right distribution channel.** With a paid Apple Developer
  account ($99/yr) you can install on your own devices two ways:
  - **Direct/dev build** via Xcode (free for 7-day-expiry personal-team builds;
    full year with the paid account) — simplest for one person.
  - **TestFlight internal testing**: up to 100 devices, builds last 90 days,
    *internal* testers skip Beta App Review entirely. Ideal for "me + maybe a
    friend," over-the-air updates, no public listing.
- **Push notifications require the paid account** (APNs auth key). The free tier
  cannot do remote push — another reason ntfy is the no-account interim.
- **No App Store review** on the internal-TestFlight/dev path means you can use
  whatever entitlements you want (e.g. background fetch, local network) without
  justifying them to a reviewer.
- One caveat worth noting: **critical alerts** (sounds that pierce
  silent/Focus) need a special Apple entitlement that's hard to get; regular
  push or ntfy's high-priority is the realistic ceiling.

### 3d. TestFlight summary (native path only)
Paid account → archive in Xcode → upload → add yourself as an internal tester →
install via TestFlight app. 90-day build expiry, OTA updates, no review. This is
the recommended distribution for the foreseeable life of this tool.

---

## 4. How the app talks to the fleet

This is the crux. **The daemon's unix socket is local-only and not network
exposed** (`Bun.serve({ unix: socketPath })`, `src/daemon.ts:25`). A phone
cannot reach a unix socket. We need a transport. Four candidate layers, then a
recommendation.

### Option A — small authenticated HTTP layer in front of the daemon ⭐
Add an opt-in **TCP HTTP listener** to the daemon (or a thin sibling process)
that exposes the same operations the unix socket already serves, plus the
write/lifecycle commands the app needs.

- The daemon is *already an HTTP server* — it serves `/health`, `/agents`,
  `/event` over the unix socket (`src/daemon.ts:30-49`). Adding a second
  `Bun.serve({ port })` that reuses `agentRows()` and the command modules is a
  small, natural extension. `agentRows()` already returns app-ready JSON
  (`AgentRow`: `name, status, provider, queued, updatedAt, dir, task,
  worktreeBranch, createdAt` — `src/commands/ls.ts`).
- **Auth**: a bearer token in `config.json` (`apiToken`), checked on every
  request. Cheap and sufficient *because* it never listens on a public
  interface — see transport below.
- **Endpoints the app needs** (proposed):
  - `GET /agents` → fleet rows (call `fleetRows()` so it includes remotes, not
    just local).
  - `GET /agents/:host/:name` → detail + queue contents + a `capture-pane`
    snapshot.
  - `POST /agents/:name/messages {text, mode: queue|now|interrupt}` → wraps
    `send`/`interrupt`.
  - `POST /agents` → `new`; `POST /agents/:name/{stop,resume,move,handoff}`;
    `DELETE /agents/:name`.
  - `GET /events` (SSE/long-poll) → live status changes so the app updates
    without polling, and to trigger push.
- **The fleet aggregation already exists** (`src/fleet.ts`): one HTTP layer on
  the machine you point the app at can fan out to remotes over ssh and return a
  merged list. The phone talks to *one* endpoint; that endpoint owns the fleet.

### Option B — Tailscale (the transport, pairs with A) ⭐
Don't expose the HTTP layer publicly. **Bind it to the tailscale interface** and
put the phone on the same tailnet (the iOS Tailscale app is first-class).

- `remote-server-plan.md` already standardizes on tailscale for this fleet and
  already runs Caddy on the server. Two clean paths:
  - Bind the daemon's HTTP listener to the tailnet IP only, or
  - Front it with `tailscale serve` for an HTTPS tailnet URL (MagicDNS gives
    `https://server/...`), so the app gets TLS + a stable name for free.
- **Security posture:** tailnet membership *is* the network boundary; the
  bearer token is defense-in-depth. No public port 22, no public 443 for this.
  This is dramatically safer than exposing an auth'd port to the internet and is
  the single biggest reason this is tractable for a personal tool.

### Option C — SSH from the phone (no new server code)
An iOS SSH client (library like NMSSH/SwiftTerm, or shelling through a
Shortcuts SSH action) runs `am ls --json`, `am send …`, etc. over ssh.

- **Pro:** zero changes to `am`; reuses the exact CLI; works for everything the
  CLI does, including `move`/`handoff`/`resume`.
- **Con:** parsing CLI output / managing ssh keys on iOS / per-command
  connection latency; no clean push channel (you'd still need ntfy/APNs for
  notifications). Good for a **hacky v0** ("Shortcuts that ssh and run
  `am ls`"), poor as a product foundation.

### Option D — lean entirely on Claude Remote Control + ntfy (no app at all)
- Notifications via `notifyCommand` → ntfy.sh → ntfy iOS app (works **today**).
- Per-agent driving via the Claude mobile app (works **today**, Claude-only).
- **Pro:** zero build. **Con:** no fleet view, no Codex, no am lifecycle, no
  cross-machine awareness, two apps instead of one. This is the **baseline to
  beat** — and a perfectly good stopgap.

### Recommendation: **A + B**, with **D as the interim** and **C as the escape hatch**
Build a token-authenticated HTTP layer on the daemon (A), reachable only over
the tailnet (B). The phone talks to one endpoint that owns fleet aggregation and
push. Until that exists, run ntfy notifications + the Claude app (D). Keep SSH
(C) in mind for power operations the HTTP layer doesn't cover yet.

```
  iPhone PWA (on tailnet, installed to Home Screen)
        │  HTTPS + bearer token  (Caddy on tailnet / tailscale serve)
        ▼
  am serve  (HTTP API + static PWA)  ──► cachedFleetRows()  ──► local state + tmux
        │                                                    └─► ssh fan-out ──► remote `am`
        └─► push: needs-attention / idle  ──► ntfy (or APNs) ──► lock screen
```

### 4e. Exposure: Caddy vs Tailscale — public vs private
The am API is an **RCE control plane** (spawn = run a process; send-message =
make an agent run shell commands; move/handoff/stop mutate the fleet). So the
exposure decision is about *blast radius*, not just convenience:

- **Public Caddy + only a bearer/basic token: don't.** A bug in the token check
  or a forgotten un-gated route is internet-facing RCE across every machine.
  One gate is not enough for this capability.
- **Caddy bound to the tailnet interface (recommended).** Caddy stays the
  server (HTTPS, stable hostname, reverse proxy) and Tailscale is the network
  gate — nothing routes from the public internet, the token is defense-in-depth.
  This is exactly what `docs/remote-server-plan.md` already prescribes:
  *"bind a Caddy site to the tailscale interface."*
- **Public Caddy + mTLS client cert** is the only acceptable *public* form:
  Caddy rejects anyone without your phone's client cert at the TLS handshake.
  Its one advantage is reachability without the VPN; cost is fiddly `.p12`
  profile management on iOS. Use only if "check agents on cellular without
  toggling Tailscale" is a hard requirement.

**Where Tailscale is strongly recommended:** the mutation/code-execution routes
(`POST /agents`, `/messages`, `move`, `handoff`, `stop`). Read-only status is
lower stakes, but since one service hosts both, put the whole thing behind the
tailnet.

### 4f. PWA authentication (the concrete model `am serve` implements)
A PWA is a browser, not a native app — no Keychain, no embedded secret. Auth is
two cooperating layers:

1. **Network layer (deployment):** Tailscale *is* the first gate (above). It
   also gives free valid HTTPS via `tailscale serve` / Caddy — required for a
   PWA at all (service workers + "Add to Home Screen" refuse plain HTTP).
2. **App layer (in code):** a **bearer token**. The static app shell carries no
   secret, so it's served unauthenticated; every `/api/*` call must send
   `Authorization: Bearer <token>`. The token is generated once
   (`am token`, stored at `~/.agent-manager/api-token`, also overridable via
   `AM_API_TOKEN`), pasted/scanned into the PWA once, and kept in the browser's
   `localStorage`.

A token in a **custom header** (not a cookie) makes **CSRF a non-issue** —
browsers don't auto-attach custom headers cross-origin and CORS preflight
guards the endpoint — so no CSRF-token machinery is needed. The one wrinkle:
iOS may evict a PWA's `localStorage` after ~7 days unused, so re-entering the
token must stay a 5-second paste/scan. (Avoiding that is a reason to go native
later, not a blocker now.)

---

## 5. Recommended MVP scope

**Theme: a read-mostly fleet dashboard with one-tap reply and reliable push.**
Deliberately skips interactive attach and most lifecycle write ops.

### Phase 0 — zero-build baseline (do this immediately, validates the need)
- Set `notifyCommand` to `curl -d "$AM_MESSAGE" -H "Title: $AM_TITLE" ntfy.sh/<private-topic>`.
- Install the ntfy iOS app, subscribe to the topic.
- Use the Claude mobile app for per-agent driving.
- **Outcome:** lock-screen push for needs-attention + idle, today, no code.
  Live with it for a week; what you still wish you had defines the real MVP.

### Phase 1 — the HTTP layer (server side, in this repo)
- Add an **opt-in** `Bun.serve({ port })` (config: `apiPort`, `apiToken`,
  `apiBind` defaulting to the tailnet/loopback — **never 0.0.0.0 by default**).
- `GET /health`, `GET /agents` (via `fleetRows()`), `GET /agents/:key`
  (detail + queue + pane snapshot), `POST /agents/:key/messages`.
- Bearer-token auth on every route. Document the tailscale-serve setup.
- This is genuinely small because the read side already exists.

### Phase 2 — the fleet UI as a **PWA** ($0, no Apple account)
Build the fleet UI as an installable web app served behind Tailscale (e.g. via
`tailscale serve`, or Caddy bound to the tailnet). It's pure HTTP to the Phase 1
layer, so no Apple account, no App Store, no weekly re-signing.
- **Fleet list** mirroring the hub sidebar: status icon, name, host badge,
  provider, queue depth, "Ns ago". Pull-to-refresh + light polling (SSE later).
- **Agent detail**: task, dir, worktree, provider, timestamps, queued messages,
  a read-only **pane snapshot** image/text.
- **Reply**: queue / now / interrupt from the detail view.
- **Spawn**: `am new` with name + optional task + dir/host picker.
- **Push stays on ntfy** (Phase 0) — the PWA doesn't try to do iOS web push.
  Use ntfy **action buttons** (HTTP-request buttons) so a lock-screen
  notification can queue a canned reply or deep-link into the PWA at that agent.

### Phase 3 — go native *only if the PWA earns it* (optional, $99/yr)
If the PWA proves the phone is where you actually triage and you want the
polish, port to native SwiftUI on TestFlight internal testing:
- **APNs push** with **notification action → reply** integrated into the app
  (no second app), reusing `shouldNotifyIdle` filtering — the main upgrade over
  ntfy.
- stop / resume / rm / move / handoff as detail-view actions.
- "Open in Claude app" deep link for Claude agents (full interactive drive).
- Optional embedded SSH attach for Codex / power use.

### What the MVP deliberately omits
- Interactive terminal attach (peek + reply covers the phone use case).
- Public/internet exposure (tailnet only).
- A native app / paid Apple account (PWA + ntfy is the $0 MVP; native is Phase 3).
- Re-creating the Claude app's per-agent chat.

---

## 6. Open questions / things to verify before building
- **Push origin:** does push fire from the daemon (needs the HTTP layer up
  24/7) or from hooks (work even with no daemon, but then need an outbound push
  call each)? Hooks already own notifications today via `notifyCommand` — likely
  cleanest to keep push in the hook path (ntfy/APNs HTTP call) and use the HTTP
  layer only for the interactive fleet API.
- **Fleet aggregation latency:** the ssh fan-out in `fleetRows()` is synchronous
  with a 5s timeout per host; over a phone connection that may need caching / an
  async variant / the daemon pre-warming a cached fleet snapshot.
- **Codex coverage:** Codex agents aren't in the Claude app at all, so they're a
  strong argument *for* a custom app — confirm Codex status/queue/send all work
  identically through the same API (they should; it's the same state files).
- **Auth hardening:** if you ever bind beyond the tailnet, the bearer token
  alone is insufficient — add TLS (tailscale serve gives it) and consider
  per-device tokens / revocation.
- **Apple account:** decided not needed for the MVP — the PWA + ntfy stack is
  $0. The $99/yr Developer Program is a Phase 3 (native) decision only.

---

## 7. One-paragraph recommendation

Don't build a terminal. The Claude mobile app already solves "drive one Claude
agent from my phone," and ntfy already gives lock-screen push today with zero
code — start there this week (Phase 0). The unique, unsolved problem is **fleet
awareness across machines and providers**: which of my many agents — local,
remote, Claude *and* Codex — needs me right now, and let me reply in one tap.
Build that as a small token-authenticated HTTP layer on the existing daemon
(the read side already exists via `agentRows()`/`fleetRows()`), reach it only
over Tailscale, and put a **PWA** on it (fleet list + agent detail + reply) with
**ntfy** for push — a $0 stack with no Apple account. MVP = fleet list + agent
detail + ntfy push + reply. Go native (TestFlight, $99/yr) only as a Phase 3
polish step if the PWA proves the phone is where you triage; attach/move/handoff
are fast-follows either way.
