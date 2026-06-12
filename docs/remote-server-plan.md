# Running `am` on a remote server

**Audience:** this document is written for a Claude Code instance running ON the
target server, with this repo cloned, tasked with finishing the setup. Verify
each assumption against the actual machine — the plan was written from the
laptop without seeing the server. The human (Alex) connects from a laptop and
expects agents to run continuously on the server.

## Goal

Agents live on the server 24/7. The laptop (or phone) is just a window:

```
laptop ── tailscale ssh ──▶ server: tmux ▸ am hub ▸ agents (claude/codex)
phone/web ── claude.ai Remote Control ──▶ same agents (no inbound ports)
laptop browser ── tailnet http ──▶ dev servers the agents run (port 5001 etc.)
```

Two complementary access paths, both already supported by the tool:

1. **SSH + the `am` hub.** `ssh -t server am` renders the full split-view UI in
   the laptop terminal. tmux does all the heavy lifting; nothing about the hub
   assumes locality. Recommend an alias on the laptop (`alias sam='ssh -t
   server am'`) and optionally mosh for flaky connections.
2. **Claude Remote Control.** Agents already launch with `--remote-control`
   (config `remoteControl: true`), so every server agent appears in
   claude.ai/code and the mobile app and can be prompted from anywhere with
   zero networking exposure — outbound HTTPS only. This is the "prompt it from
   the laptop as needed" path with the least friction.

## What already works unchanged

- Agents are detached tmux sessions; nothing requires a GUI or a logged-in
  desktop. State is flat files under `~/.agent-manager/`.
- The daemon is a unix socket auto-started by `am new`; hooks fall back when
  it's down. No launchd/systemd dependency.
- Status hooks, queue delivery, resume/revive, snapshots, transcripts, the
  picker/hub UI, `am watch` — all filesystem + tmux, fully portable.
- ctrl-q detach, tab titles, wheel scrolling: tmux-side, work over SSH.
- Shift-drag copying is handled by the LOCAL terminal (Ghostty), so it works
  over SSH untouched. Same for cmd+click on URLs/OSC-8 links — detection is
  terminal-local.

## Code changes needed (small, do these on the server and PR them)

1. **`notifyMac` (src/commands/hook.ts) is macOS-only** (osascript /
   terminal-notifier). Make it platform-aware:
   - Add a `notifyCommand` config value (`~/.agent-manager/config.json`): a
     command template run with title/message (env vars `AM_TITLE`,
     `AM_MESSAGE`). When set, it wins on any platform.
   - On linux with nothing configured: try `notify-send` if present, else
     no-op silently. Never let a notifier block a hook (spawn unref'd, as now).
   - Recommended server setup: [ntfy.sh](https://ntfy.sh) — `notifyCommand`
     posting to a private topic gives Alex push notifications on the phone for
     needs-attention/idle events. Ask Alex for a topic name before wiring.
2. **URL click handler (src/commands/click.ts) calls `open`** — on a headless
   server that's wrong twice (no browser, wrong machine). Use
   `xdg-open`-if-present, but better: when `process.platform !== "darwin"` and
   no display, change the click binding to copy the URL to the tmux buffer and
   `display-message` it instead. (Cmd+click in Ghostty already opens URLs
   laptop-side over SSH, so plain-click open matters much less remotely.)
3. **Grep for anything else darwin-flavored** before assuming this list is
   complete. As of writing, these two functions are the only ones.

## Server checklist (verify, install what's missing)

Environment — much of this Alex says is already done; verify rather than redo:

- [ ] bun (`curl -fsSL https://bun.sh/install | bash`), tmux ≥ 3.2 (the spawn
      path uses `new-session -e`), git, gh (authed), ripgrep etc.
- [ ] `claude` CLI installed and logged in (`claude login` — OAuth; Max plan
      covers multiple machines). Verify `claude -p "ok"` works. Same for
      `codex` if codex agents are wanted.
- [ ] This repo cloned (github.com/lalexgap/agent-manager), `bun install`,
      `bun link` so `am` is on PATH (including non-interactive shells: check
      PATH in `~/.profile`/`~/.bashrc` for ssh non-login commands).
- [ ] tailscale up and reachable from the laptop's tailnet. SSH works
      (`tailscale ssh` or plain sshd over the tailnet — no public port 22).
- [ ] `loginctl enable-linger $USER` (systemd) so user processes survive
      logout — tmux usually survives anyway, but lingering removes surprises.
- [ ] Optional but recommended: a systemd **user** unit that runs
      `am daemon start` at boot, so the daemon (delivery scheduling, watch,
      dead-session sweep) is up before the first interactive login. Agents
      themselves do NOT auto-revive on reboot by design — they're revived
      on demand from the picker (enter on a dead agent) or `am resume`.
- [ ] Project workspaces the agents will work in: repos cloned, secrets/env
      files in place, language toolchains installed, dev servers start.
- [ ] Folder trust: run `claude` once interactively in each workspace dir (or
      spawn a throwaway agent and accept the prompt) — otherwise headless
      spawns sit at the trust dialog ("starting", no activity). `am` docs note
      the unblock: `tmux send-keys -t 'agentmgr-<name>:' Enter`.

## Exposing dev servers (wrinkle 2)

**The server already runs Caddy with URLs exposed — do not disturb that
setup.** Tailscale coexists with it (separate interface; no inbound
interception): keep Caddy as the front door for anything deliberately public,
and use the tailnet for private access. Audit what Caddy already exposes
before adding anything; prefer NOT using `tailscale serve`/`funnel` at all on
this box since Caddy fills that role. If a private-but-nice URL is wanted,
bind a Caddy site to the tailscale interface instead.

For everything not already behind Caddy: **don't expose it publicly — use the
tailnet.**

- Any port an agent's dev server binds (e.g. 5001) is reachable from the
  laptop as `http://<server-tailnet-name>:5001` with zero config, as long as
  the dev server listens on 0.0.0.0 or the tailscale interface (many bind
  127.0.0.1 by default — check and adjust per project).
- If HTTPS or a stable URL is wanted: `tailscale serve` (tailnet-only) or
  `tailscale funnel` (public — only if genuinely needed).
- Hostname niceties: MagicDNS makes `http://server:5001` work.

## Verification (run all of it on the server when done)

1. `bun test` in the repo passes.
2. `am new demo --dir /tmp/am-demo -m "say hi"` from a plain ssh shell:
   trust prompt handled, status goes working→idle, `am ls` correct.
3. `am send demo "..."` while working → queued → auto-delivered on idle.
4. `/exit` the agent, `am resume demo` → conversation context intact.
5. From the LAPTOP: `ssh -t server am` → hub renders, preview works, ctrl-q
   detach works, picking a dead agent revives it.
6. Remote Control: server agent appears in claude.ai/code session list with a
   green dot; send it a prompt from the web/phone.
7. Notifications: trigger a permission prompt; whatever notify path was
   configured fires (or cleanly no-ops).
8. Reboot the server: daemon comes back (if the systemd unit was added),
   `am ls` shows agents as dead, reviving one from the picker works.

## Explicitly out of scope (don't build unless Alex asks)

- Auto-reviving all agents on boot.
- Any web dashboard; claude.ai Remote Control covers remote UX.
- Public exposure of anything beyond `tailscale funnel` on a case-by-case
  basis.
