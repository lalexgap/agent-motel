# Reverse SSH: let the server reach a roaming host

By default the fleet is one-directional: a laptop with the server in
`config.remotes` can ssh in and see/message the server's agents, but the
**server can't reach back** to the laptop (it roams, sleeps, has no inbound
route). Store-and-forward (the outbox) covers messaging across that gap, but the
server still can't *see* the laptop's agents or reach them live.

`am tunnel` closes that — while the laptop is online — with a **reverse SSH
tunnel**. The laptop (which can always reach the server) opens a tunnel so the
server can connect *back* to the laptop's sshd. Once up, the laptop is just
another ssh remote: add it to the server's `config.remotes` and the whole fleet
model works both ways — `am ls` shows the laptop's agents, `am send <laptop-agent>`
forwards live instead of queueing, and you get a shared agent list.

It's an **online accelerator, not a replacement**: when the laptop sleeps or
roams the tunnel drops and store-and-forward takes over automatically. So you
want both.

## Trade-off to accept first

A reverse tunnel flips the laptop from outbound-only to something the **server
can initiate into**. Only set this up toward a server you trust, and keep the
laptop's sshd on key-only auth. If that exposure isn't acceptable, prefer the
store-and-forward outbox alone (or the long-poll push option) — both keep the
laptop purely a client.

## Setup

### 1. On the roaming host (laptop): enable sshd

The tunnel forwards to the laptop's sshd, so it must be running.
- macOS: System Settings → General → Sharing → **Remote Login** on
  (or `sudo systemsetup -setremotelogin on`).
- Linux: `sudo systemctl enable --now ssh`.

### 2. On the laptop: run the tunnel

```sh
am tunnel <server>            # <server> = the ssh host alias of your always-on box
```

This keeps `ssh -N -R <tunnelPort>:localhost:22 <server>` alive, reconnecting
with backoff if the link drops. `tunnelPort` defaults to **2222**
(`--port` or `config.tunnelPort` to change; `--ssh-port` if the laptop's sshd
isn't on 22). Run it under a service so it persists — see `docs/am-tunnel.service`.

### 3. On the server: add the laptop as a remote

Give ssh a Host alias that points at the tunnel, in `~/.ssh/config`:

```
Host laptop
  HostName localhost
  Port 2222
  User <your-laptop-username>
```

Then add it to the server's `~/.agent-manager/config.json`:

```json
{ "remotes": ["laptop"] }
```

### 4. Verify (on the server)

```sh
am -H laptop ls        # should list the laptop's agents through the tunnel
am ls                  # the merged fleet now includes them
am send <laptop-agent> "hi"   # forwards live over the tunnel
```

## How it fits the rest

- **Both machines should set `hostAlias`** to the name the other lists them under
  in `config.remotes`, so cross-host attribution (`[am · from laptop:api]`) is
  reply-able in both directions.
- When the tunnel is **down** (laptop offline), `am send <laptop-agent>` falls
  back to the outbox and the laptop collects it on reconnect — no message lost.
- The tunnel is plain ssh; `am` stays transport-ignorant. `am tunnel` only
  supervises the connection.
