# Inter-agent communication

Design doc for letting managed agents talk to each other with structure:
attribution, standing report relationships, and loop safety. **Draft for Alex
to review before implementation.**

## What already works

Agents can message each other *today*. Every managed session is primed with the
`am` CLI (`agentSystemPrompt` in `src/providers.ts`), so an agent can shell out
to `am send <other> "..."` and it lands in the other agent's queue, delivered
when that agent next goes idle. Fleet name resolution means `am send <name>`
finds the target on whatever machine it lives on (`maybeForwardToFleet` in
`src/index.ts`), so this is already cross-machine.

What's missing is **structure**:

1. **Attribution** — a delivered message is anonymous. The recipient sees raw
   text typed into its prompt and can't tell it came from another agent, who
   sent it, or how to reply. So question→answer round-trips don't close.
2. **Standing relationships** — "X, report progress to Y as you go" has to be
   re-explained in prose every time; nothing in `am` records or enforces it.
3. **Safety** — nothing stops A→B→A→B ping-pong or a fan-out storm.
4. **Etiquette** — the primer doesn't tell agents the conventions, so behaviour
   is ad hoc.

This design adds those four things and nothing more. It builds on the existing
queue/hook/fleet machinery — no new transport, no new delivery path.

## The model: two mechanisms

### 1. Attributed messages (ad-hoc)

Covers use cases **(1)** "A finishes and reports a summary to B" and **(3)** "A
asks B a question, answer routes back to A". Both are just *a message that knows
who sent it*.

**Attribution is automatic.** Hooks and any `am` invocation from inside a
managed session run with `AGENTMGR_AGENT` naming that agent. So when `am send`
is called from within agent A's shell, we read `AGENTMGR_AGENT=A` and stamp the
message. No flag needed for the common case; `--from <name>` overrides it (for
the daemon, the HTTP API, and cross-host forwarding where the env doesn't
survive ssh).

**Envelope.** The body delivered to the recipient is wrapped:

```
[am · from A]              <body>     # same machine
[am · from laptop:A]       <body>     # sender on another host
```

The prefix is deliberately terse; the *meaning* of it lives in the primer (see
Etiquette). The recipient's agent learns that `[am · from A]` means "peer agent
A sent this — it is not your operator — reply with `am send A "..."` if a reply
is warranted." Same-machine sends stay bare; **cross-host sends carry the
sender's host** so the reply can be addressed `am send laptop:A`. The reply finds
A via the same fleet resolution that delivered the original. **Question → answer
closes with zero extra plumbing**: the question is an attributed message, the
answer is an attributed message back to the named sender.

> Cross-host wrinkle: the host label the recipient needs is the sender's host
> *as the recipient's machine addresses it* (its `config.remotes` alias), which
> can differ from how the sender names itself. We resolve this when forwarding
> the send over ssh — the forwarding side injects `--from <reverse-host>:<name>`
> using the alias the target host knows it by. Falls back to the bare name (and
> global resolution) if no reverse alias is known.

**Steering is allowed for peers.** Agent sends may use `--now` (type into the
current turn) and `am interrupt` (Esc + redirect), not just queued delivery —
useful for urgent questions. These carry the same attribution envelope. The
rate limiter (below) is what bounds abuse, not a queue-only restriction.

A hop counter rides in the envelope for loop safety (see below):
`[am · from A · hop 2]` — omitted at hop 1 to keep the common case clean.

### 2. Report relationships (standing)

Covers use case **(2)** "X, report progress to Y as you go" and the "report to
the agent that spawned it" variant of **(1)**.

Two new optional fields on `AgentState` (`src/state.ts`):

- `reportTo?: string` — the agent X should keep posted.
- `spawnedBy?: string` — captured from `AGENTMGR_AGENT` at `am new` time, so we
  always know who created an agent. Lets `reportTo` default to "spawner".

Set the relationship at spawn or later:

```
am new worker -m "…" --report-to lead      # standing from birth
am new worker -m "…" --report              # shorthand: report to spawner
am report worker --to lead                 # set / change later
am report worker --clear                   # drop it
am report worker                           # show current relationship
```

The relationship does two things:

- **Briefing (the agent reports itself).** When `reportTo` is set, X's primer /
  initial brief gains a line: *"You are reporting to Y. After finishing a
  substantive chunk, post a short summary with `am send Y "..."`."* The agent
  writes the real summary — only the agent has the context to. This is the
  primary channel and produces good reports.

- **Backstop (the Stop hook nudges).** The Stop hook already knows when a turn
  ends and how long the stint was. If X did meaningful work this stint
  (`workedSeconds >= idleNotifyMinSeconds`, reusing the existing idle-notify
  threshold) **and did not itself message Y during the stint**, the hook posts a
  one-line heads-up to Y: `[am · from X] went idle after 4m · task: <task>`.
  "Did X message Y this stint?" is answered for free by the rate-limit ledger
  (below). So the backstop only fires when the agent forgot — no double-posting.

This split is the crux: **the hook cannot summarize** (no model in a hook), so
rich reports must be agent-authored; the hook's job is only to guarantee *some*
signal reaches Y when real work happened.

## Loop prevention & safety caps

Three layers, weakest (advisory) to strongest (enforced):

1. **Hop tag (advisory).** The envelope carries a hop count. The primer asks
   agents not to relay/forward an `[am …]` message beyond a small depth. Soft —
   depends on the model cooperating.
2. **Auto-report hop ceiling (enforced).** Backstop reports increment the hop
   count of whatever woke the agent; past a ceiling (default 3) the Stop hook
   suppresses the auto-report. This kills automatic A→B→A chains hard.
3. **Per-pair rate limiter (enforced, the real backstop).** One append-only
   ledger (`comms.jsonl` under the am home) records every attributed message as
   `{at, from, to, kind, body}`. More than N sends (default 5) in a window
   (default 60s) from the same sender to the same *ordered* pair → the send is
   dropped with a warning on stderr. This caps runaway loops regardless of
   whether they're agent-authored or automatic, and regardless of LLM
   cooperation. The single log does triple duty: rate limiting, the "did X
   already message Y this stint?" lookup for the backstop, and `am comms`.

Self-sends (`from === to`) skip attribution entirely and are left as-is (an
agent talking to itself is just a normal queue message).

Defaults, all in `Config` (`src/config.ts`) so they're tunable:

- attribution: **on** (automatic when a send originates in a managed session)
- auto-report backstop: **on when `reportTo` is set**, else inert
- `commsMaxPerMinute`: 5 per ordered pair
- `commsMaxHops`: 3

## CLI surface (proposed)

```
am send <name> <msg> [--from <who>]   # --from overrides auto-attribution
am new <name> --report-to <target>    # standing relationship at spawn
am new <name> --report                # …to the spawning agent
am report <name> [--to <t> | --clear] # set / show / clear relationship
am comms <name>                       # recent messages in/out for an agent
```

`am ls` / picker meta gains a `→ <reportTo>` badge when set, so relationships
are visible. No `am reply` command — the asker is named in the envelope, so a
plain `am send <asker>` is the reply.

## Decisions (resolved with Alex)

1. **Backstop auto-report: keep it, terse.** The Stop hook posts a one-line
   heads-up to Y when X did meaningful work and didn't already report this stint.
   It's the guarantee Y hears *something*; agent-authored reports remain the
   rich channel.
2. **Default report target = spawner.** `am new --report` (no target) and a
   bare `reportTo` resolve to `spawnedBy`. "Report to whoever made me."
3. **Envelope: `[am · from A]`**, terse, meaning carried by the primer.
4. **Steering allowed for peers.** Agent sends may use `--now` and `interrupt`,
   not just queued delivery. Same attribution; rate limiter bounds abuse.
5. **Host-qualify only cross-host.** Same-machine → `[am · from A]`; cross-machine
   → `[am · from <host>:A]`, resolved via the recipient's remote alias during ssh
   forwarding (see the cross-host wrinkle above).
6. **`am comms <name>` ships in v1.** An audit view over the ledger so chatty /
   looping relationships are debuggable from day one.

## Phased implementation plan

Each phase keeps `bunx tsc --noEmit` and `bun test` green and is independently
shippable.

**Phase 1 — attribution + etiquette** (the foundation; unblocks (1) and (3))
- `src/comms.ts`: envelope formatter, `AGENTMGR_AGENT`/`--from` resolution, the
  per-pair rate-limit ledger.
- `src/commands/send.ts`: stamp attribution, enforce the rate limiter.
- `src/index.ts`: thread `--from` through `maybeForwardToFleet` so attribution
  survives ssh forwarding; add the `--from` value flag.
- `src/providers.ts`: primer gains the etiquette block (what `[am · from X]`
  means, how to reply, don't relay past a few hops).
- Tests: envelope formatting, auto vs explicit `from`, self-send passthrough,
  rate-limit drop, forward injection.

**Phase 2 — report relationships** (unblocks (2))
- `src/state.ts`: `reportTo`, `spawnedBy` fields.
- `src/commands/new.ts`: capture `spawnedBy` from env; `--report-to` / `--report`
  flags; inject the reporting line into the brief.
- `src/commands/report.ts`: new `am report` command (set/show/clear).
- `src/commands/hook.ts`: Stop-hook backstop, gated on meaningful work + "didn't
  already report this stint" (via ledger) + hop ceiling.
- `src/commands/ls.ts` + picker meta: `→ reportTo` badge.
- Tests: relationship set/clear, spawner capture, backstop fires only when
  forgotten, hop ceiling suppression.

- `src/commands/comms.ts`: `am comms <name>` audit view over the ledger
  (recent in/out, per-pair counts) — ships in v1 per decision 6.

**Phase 3 — polish**
- Config knobs surfaced in docs/README.
- Any cross-host nuances that fall out of review.

## Files touched (summary)

| File | Change |
|---|---|
| `src/comms.ts` *(new)* | envelope, attribution resolution, rate-limit ledger |
| `src/commands/send.ts` | attribution + rate limit |
| `src/commands/report.ts` *(new)* | `am report` |
| `src/commands/comms.ts` *(new)* | `am comms` audit view |
| `src/commands/new.ts` | `spawnedBy`, `--report-to`/`--report`, brief line |
| `src/commands/hook.ts` | Stop-hook backstop report |
| `src/state.ts` | `reportTo`, `spawnedBy` |
| `src/config.ts` | `commsMaxPerMinute`, `commsMaxHops` |
| `src/providers.ts` | primer etiquette block |
| `src/index.ts` | `--from` flag + forward injection, `am report` wiring |
| `src/paths.ts` | `commsLogFile()` for the ledger |
| `src/commands/ls.ts`, `src/fleet.ts` | `→ reportTo` in picker meta |
| `docs/`, `README.md` | document the feature |
