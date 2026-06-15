# Reliable & performant inter-agent messaging — redesign plan

Synthesis of a 4-agent investigation (addressing, reliability, transport, current-state
audit). Goal: any agent can message and **reply to** any other — local or across
machines — with no silent loss and low latency. Draft for Alex's review.

## TL;DR

- **The live reply bug is diagnosed and is a one-line fix.** The outbox relay stamps
  `[am · from name@host]`, but every reply path (`am send`, `splitFleetKey`, the primer)
  understands only `host:name` (colon). So a relayed message is *structurally
  un-replyable*: pasting `agent-comms@gapserver` back has no colon → treated as a literal
  name → misrouted into the outbox under a garbage name → expires. That, not agent
  behavior, is why `bin_ecs_runner`'s reply never came back.
- Three pillars to make messaging solid: **Addressing** (one consistent address that's
  always reply-able), **Reliability** (at-least-once + dedup; no silent drops),
  **Performance** (cheap polls, low latency).
- Phased so each step is independently shippable and `tsc`/`bun test` stay green.

## How it works today (three paths)

1. **Local** — `am send <name>` types into the target's tmux pane (queued, drained on idle).
2. **Forward** (laptop→server, server reachable) — `maybeForwardToFleet` ssh-runs the
   command on the far host; `injectSender` adds `--from hostAlias:name`. Stamp: `host:name`.
3. **Outbox** (server→laptop, laptop roams/no sshd) — sender writes
   `~/.agent-manager/outbox/<to>.jsonl`; the laptop daemon polls each remote every
   `outboxPollSeconds` via `am __outbox-take`, injects with stamp `name@host`. ← inconsistent.

## Problems found (ranked, grouped)

**Correctness**
- **C1 — Un-replyable outbox attribution** (`outbox.ts` `collectedSender` `name@host` vs
  `fleet.ts` `splitFleetKey` colon-only). *Root cause of the live bug.*
- C2 — Three spellings of "the host": forward uses `config.hostAlias` (often unset →
  bare), outbox uses `os.hostname()`, fleet uses the `config.remotes` ssh string. They
  can denote one machine three ways, so a `host:name` reply may not match a remote.
- C3 — No agent knows its own canonical address (only bare `AGENTMGR_AGENT`).
- C4 — HTTP API (`server.ts`) sends with no `from` → unattributed, unrepliable, bypasses
  the rate limiter.
- C5 — Outbox keyed on bare name; `am move` doesn't carry the outbox, and `clone` makes
  two machines advertise the same name → non-deterministic pickup.

**Reliability**
- R1 — **Take-before-inject silent loss**: `__outbox-take` deletes remotely *before* the
  collector persists locally; a crash in between loses the messages with no trace.
- R2 — No message IDs anywhere → no dedup/idempotency; any retry double-delivers.
- R3 — `deliverNext` peek→send→pop race: Stop hook + daemon `/event` + reconcile can all
  fire for one agent concurrently → same message typed twice.
- R4 — Rate-limiter drops are **silent** in the collector and report-backstop paths (no
  log, no bounce, no requeue).
- R5 — `deliverNext` pops *before* verifying the submit landed → a swallowed Enter on
  crash loses the message.
- R6 — Unguarded per-line `JSON.parse` in the outbox/comms/bounce readers → one torn line
  bricks the whole read path.

**Performance**
- P1 — Every ssh pays full handshake + login-shell spawn; no `ControlMaster` reuse.
- P2 — Two independent ssh streams to the same host every ~5s (daemon outbox poll + TUI
  fleet refresh), unmultiplexed.
- P3 — Fixed 5s poll: wasteful when idle, laggy mid-conversation; no backoff, no
  "any mail?" probe; the comms ledger is re-parsed in full on every send (grows forever).

## The plan

### Phase 0 — Correctness quick wins (fixes the live bug; stops silent drops) ✅ SHIPPED

Small, localized, high-value. Implemented: `collectedSender` flips to `host:name`;
`splitFleetKey`/`splitAddr` is one tolerant parser (handles legacy `name@host`);
`outboxFallback`/`commsFor` de-qualify via it; the forward path always host-qualifies;
primer rewritten to "paste exactly what follows `from`"; collector + report-backstop
rate-limit drops are logged; JSONL readers skip torn lines; comms ledger is size-capped.
(Phase 0's deeper addressing items — `AGENTMGR_AGENT_ADDR`, `hostAlias` config default —
move into the reliability PR.)

1. **Unify addressing on `host:name`** (C1, C2, C3):
   - Flip `collectedSender`: `${from}@${origin}` → `${origin}:${from}` (`outbox.ts`). *This
     one line makes outbox replies route.*
   - Add legacy-`@` tolerance to `splitFleetKey` (`fleet.ts`) so in-flight/old-peer
     `name@host` still parses instead of misrouting.
   - Route the hand-rolled `indexOf(":")` splits in `send.ts` (`outboxFallback`) and
     `comms.ts` (`commsFor`) through `splitFleetKey`.
   - Default `config.hostAlias` to `shortHost(os.hostname())` so the forward path always
     qualifies and matches what outbox stamps.
   - Export `AGENTMGR_AGENT_ADDR=<host>:<name>` at spawn; primer self-identity line.
   - Primer rewrite to the invariant: **"reply by pasting exactly what follows `from`."**
2. **Stop silent drops** (C4, R4): pass `from` through the HTTP API send; log (and where
   possible bounce) rate-limited drops in the collector and report backstop.
3. **Robust readers** (R6): wrap per-line `JSON.parse` with skip-on-error; write the
   bounce log via tmp+rename; cap/rotate the comms ledger.

### Phase 1 — Reliability: at-least-once + dedup ✅ SHIPPED (this PR)

Convert "at-most-once with a silent hole" → "at-least-once with dedup."
Implemented: ULID msgIds (`src/msgid.ts`) on outbox + comms entries;
`__outbox-claim`/`__outbox-ack`/reclaim replacing the destructive take (the
collector acks only after durable local delivery; an unacked claim is reclaimed);
receiver dedup by msgId (`seenRecently`); per-agent cross-process delivery lock
(O_EXCL) fixing the double-send race; per-sweep FIFO by msgId. Deferred: threading
msgId through the local queue + `am move` payload, and pop-after-verify (its
duplicate needs local-queue dedup first) — noted below.

1. **Message IDs** (R2): new `src/msgid.ts` minting a ULID (CSPRNG + monotonic guard for
   coarse `Date.now()`); thread `msgId` through `queueAppend`, `OutboxEntry`, `CommsEntry`,
   and `MovePayload.queue` (so IDs survive move/clone).
2. **Claim/ack/reclaim** replacing destructive take (R1): `__outbox-claim <cid>` renames
   to `*.claimed` and returns (no delete); collector injects locally, then `__outbox-ack
   <cid>` deletes; stale claims older than a timeout are renamed back (reclaim, folded into
   claim for restart recovery). Keep `__outbox-take` as a deprecated shim for old remotes.
3. **Receiver dedup** by `msgId` (using the comms ledger / a small `seen` ring), so
   redelivery is invisible.
4. **Pop-after-verify** in `deliverNext` (R5) and a per-agent delivery lock (R3).
5. **Per-sender FIFO**: sort each injected batch by `msgId` before append.

### Phase 2 — Performance: cheap + low-latency ✅ PARTLY SHIPPED (this PR)

Implemented: ssh **ControlMaster** multiplexing in `sshArgv` + raw ssh helpers
(opt-out `AM_SSH_NO_MUX=1`); **adaptive poll** (hot floor `outboxPollSeconds`=2s,
×1.5 backoff to `outboxPollMaxSeconds`=30s, snap-to-hot on received mail, ±10%
jitter, self-rescheduling). Deferred: daemon-owned combined sync (TUI reads the
socket instead of its own ssh) and the "any mail?" peek — below.

1. **ssh `ControlMaster` multiplexing** in `sshArgv` (P1) — biggest win, smallest change;
   purely ssh-side, shared automatically across daemon + TUI. ~200ms → ~10ms per poll.
2. **Adaptive poll cadence** (P3): self-rescheduling loop, hot floor = `outboxPollSeconds`
   (drop default to ~1s once polls are cheap), idle cap new `outboxPollMaxSeconds` (~30s),
   ×1.5 backoff, snap-to-hot on received mail and on local send, ±10% jitter.
3. **Daemon-owned combined sync** (P2): one `__sync --for <names>` returning
   `{rows, mailFor}`; the daemon issues the destructive claim only when `mailFor` is
   non-empty; the TUI reads fleet rows from the daemon's unix socket instead of sshing
   itself. Collapses two ssh streams to one and keeps the destructive take single-owned.

### Phase 3 — Deeper / optional (on demand or Alex's call)

- **Long-poll push** (`am __mail-stream`, IMAP-IDLE-over-ssh) gated to attached/foreground
  sessions, with the adaptive poll as the offline/reconnect fallback → sub-100ms while online.
- **App-level ingest-ack** (`am __ingest-ack <msgId>`) — the only thing proving the *agent*
  (not just the terminal) ingested a message.
- **Outbox-on-move** + resolve `clone`'s duplicate-name addressing ambiguity (C5).
- Route `--now`/`interrupt` through the queue with a priority flag so ordering + the
  submit-retry guard still apply.

## Cross-machine migration constraint

Both machines need the new code for a full round trip. Compatibility is handled so a
mixed fleet degrades, not breaks: the `@`-tolerant parser lets a new machine route replies
from an old peer; claim/ack falls back to `__outbox-take` against an old remote (lossy, as
today). Outbox entries store `from`/`fromHost` *structurally*, so the colon-vs-at decision
is applied fresh at injection — in-flight entries auto-upgrade on the next sweep.

## Recommended first cut

Phase 0 #1 alone (the `collectedSender` colon flip + `splitFleetKey` tolerance + primer)
fixes the observed reply failure and is ~20 lines. Phase 1 #1–#2 close the only *silent*
unbounded-loss window. Phase 2 #1 (`ControlMaster`) is a near-free latency/battery win.
Those three are the high-leverage core; the rest is polish and can follow.
