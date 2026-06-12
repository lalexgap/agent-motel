# An iOS app for `am` — research & design exploration

**Status:** research / design only. Nothing here is built. The goal is to decide
*whether* an iOS app is worth building, *what* it should do, and *how* it would
reach the fleet — then propose an MVP scope.

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
| **PWA (installable web app)** | One codebase, instant deploy, no App Store, trivial to host behind tailscale/Caddy | **Web Push on iOS is weak**: only when installed to Home Screen, no critical alerts, unreliable background wake — fatal for a notify-first tool. No native SSH. | **Great for a v0 prototype, not the notify story** |
| **Wrap an existing tool** | The Claude app already *is* a high-quality wrapper for the per-agent case | Covers one agent at a time, Claude-only, no fleet/Codex/am-lifecycle | **Use it, don't rebuild it — deep-link to it** |
| **ntfy.sh (off-the-shelf push)** | `notifyCommand` already supports it (`curl ntfy.sh/<topic>`); the ntfy iOS app gives lock-screen push **today, zero code** | Generic notification list, no fleet view, no reply-with-context | **Ship this first as the notification MVP while a real app is built** |

**Recommendation:** native SwiftUI for the product; **ntfy as a zero-build
interim** for notifications (it already works via `notifyCommand`); optionally a
PWA prototype of the fleet view to validate the API before writing Swift.

### 3b. App Store constraints for a personal tool

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

### 3c. TestFlight summary
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
  iPhone (native app, on tailnet)
        │  HTTPS + bearer token  (tailscale serve / MagicDNS)
        ▼
  am daemon HTTP layer  ──► agentRows()/fleetRows()  ──► local state files + tmux
        │                                              └─► ssh fan-out ──► remote `am`
        └─► push: needs-attention / idle  ──► APNs (or ntfy) ──► lock screen
```

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

### Phase 2 — native iOS app (TestFlight, internal)
- **Fleet list** mirroring the hub sidebar: status icon, name, host badge,
  provider, queue depth, "Ns ago". Pull-to-refresh + light polling (SSE later).
- **Agent detail**: task, dir, worktree, provider, timestamps, queued messages,
  a read-only **pane snapshot** image/text.
- **Reply**: queue / now / interrupt from the detail view.
- **Push**: APNs for needs-attention + idle, reusing `shouldNotifyIdle`
  filtering; **notification action → reply** (queue a message without opening
  the app). This is the single highest-value interaction — prioritize it.
- **Spawn**: `am new` with name + optional task + dir/host picker.

### Phase 3 — lifecycle + jump-in (post-MVP)
- stop / resume / rm / move / handoff as detail-view actions.
- "Open in Claude app" deep link for Claude agents (full interactive drive).
- Optional embedded SSH attach for Codex / power use — only if Phase 2 proves
  the phone is where you actually want to work, not just triage.

### What the MVP deliberately omits
- Interactive terminal attach (peek + reply covers the phone use case).
- Public/internet exposure (tailnet only).
- Multi-user / accounts / the App Store (single-user, TestFlight internal).
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
- **Apple account:** confirm the $99/yr Developer Program is acceptable; without
  it, ntfy (Phase 0) is the ceiling for push.

---

## 7. One-paragraph recommendation

Don't build a terminal. The Claude mobile app already solves "drive one Claude
agent from my phone," and ntfy already gives lock-screen push today with zero
code — start there this week (Phase 0). The unique, unsolved problem is **fleet
awareness across machines and providers**: which of my many agents — local,
remote, Claude *and* Codex — needs me right now, and let me reply in one tap.
Build that as a small token-authenticated HTTP layer on the existing daemon
(the read side already exists via `agentRows()`/`fleetRows()`), reach it only
over Tailscale, and put a native SwiftUI app on it distributed through
TestFlight internal testing. MVP = fleet list + agent detail + push + reply.
Everything else (attach, move, handoff) is a fast-follow once the phone proves
it's where you triage.
