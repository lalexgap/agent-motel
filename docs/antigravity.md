# Native Antigravity provider

AM's canonical provider ID is **`antigravity`**, selected with **`--antigravity`**
(or `--provider antigravity`). The executable is **`agy`**. Gemini 4 Argon is a
model served by that runtime; it is not a provider alias. Existing Claude/Codex
launches and AM's Codex defaults are unchanged.

This integration uses Google's documented **headless bidirectional stream**,
wrapped in an AM terminal runner. It does not launch the native agy TUI. This
matters because Google documents strict model rejection in headless mode while
interactive model selection can fall back. Every launch pins a model; the AM
default for this provider is `gemini-4-argon-high`. AM verifies the stream's
model echo and conversation identity before reporting readiness or submitting
initial task/role input. An unavailable
model is an error, including a model configured on a role. AM never retries with
a different model.

## Prerequisites and billing

Install Antigravity CLI using Google's [Quickstart](https://antigravity.google/docs/quickstart)
and [installation/authentication guide](https://antigravity.google/docs/cli/install).
Then authenticate with `agy` separately in an interactive terminal on the host
that will run the agent. Over SSH, Google documents a manual browser URL/code
flow. AM does not initiate sign-in, collect tokens, copy credentials across
hosts, or rewrite Google account settings. Headless mode uses existing
credentials and should report an authentication error if none are available.
AM also bounds startup waiting so broken authentication cannot appear idle
forever. Missing `agy` produces an installation error before creating an agent.

Google's [Argon announcement](https://antigravity.google/blog/gemini-4-argon-in-google-antigravity)
announces Argon for Google AI Pro/Ultra subscribers and eligible enterprise
subscriptions. Account availability and quota must be checked with `agy models`.
This is distinct from configuring the CLI to use a Gemini API key: Google's
[authentication guide](https://antigravity.google/docs/install?tab=cli) describes
`modelProvider: "gemini"` plus `GEMINI_API_KEY`, which sends requests directly to
the Gemini API. Do not assume subscription quota covers API billing. AM does not
choose an authentication/billing route or enable credit overages.

## Launch and conversation identity

```sh
agy models
am models --antigravity
am new argon-task --antigravity --model gemini-4-argon-high -m 'Inspect this repo'
am new argon-adopt --antigravity --model gemini-4-argon-high --resume <conversation-id> -m 'Continue the inspection'
am resume argon-task -m 'Continue the inspection'
am restart argon-task --model gemini-4-argon-medium -m 'Continue with this model'
am send argon-task 'Next task'
am interrupt argon-task
```

`--effort low|medium|high` is passed as agy's own `--effort`. Model-specific
availability remains subject to the installed CLI/account. Catalog parsing
accepts the documented plain slug/display-name rows and fails closed when the
probe produces errors, an unknown shape, or authentication text. Discovery is
bounded and does not invoke a model. When discovery is unavailable, runtime
model validation remains strict; AM does not invent an available catalog.

New adoption accepts an exact `--resume <id>` or explicitly requested
`--continue` (agy's most recent conversation). Bare `--resume`/the interactive
picker is unsupported. Subsequent AM resume/restart always uses the saved exact
conversation ID and refuses to guess the latest session if it is missing.
`am restart --model default` means AM's explicit Antigravity default pin, not a
mutable native model default. Named AM roles provide snapshotted instructions
and can pin the provider/model. Native role-file export is a separate,
unsupported capability.

Remote forwarding verifies Antigravity support before creation and checks the
resulting provider. Older AM versions that ignore unknown flags must be upgraded;
AM refuses to assume they honored `--antigravity`. The target host must have its
own agy installation and authentication.

## Managed lifecycle and safety

The runner starts `agy --input-format stream-json --output-format stream-json`
with an exact `--model`, optional `--effort`/`--conversation`, and explicit
`--print-timeout 5m`. Prompts are NDJSON `user` messages on stdin. A command-line
`-p` prompt is deliberately not used: Google says streaming input drops it.

An `init` event establishes identity. A native `user_input` step acknowledges a
submitted message; a successful terminal `result` completes its turn. AM records
starting/working/idle/exited from these events and process termination, not from
screen text. Invalid protocol, mismatched identity/model, incomplete output,
startup/ack timeouts and process failures exit with a diagnostic category.
Unknown events do not execute code or act as hooks. Output, request and diagnostic
buffers are bounded. Raw provider stderr/auth URLs/tokens are not persisted or
echoed by AM; inspect agy directly if more detail is needed.

Input larger than 64 KiB after attribution is rejected before enqueueing, including
API/peer/report queue producers. An already-invalid stored queue head is preserved
and marks needs-attention with explicit inspection/clear/restart instructions.

Queued input travels through a private Unix socket bound to a random launch
nonce and agent incarnation. Only one turn is submitted at a time. The runner
holds input while the operator has a draft or the input state is unavailable;
it never presses Escape/Ctrl-U to overwrite an operator's text. A durable
per-message marker is written before submission. Native acknowledgement settles
the exact queue entry and receipt. An ambiguous handoff remains unknown rather
than being automatically resent across restart. Inspect the transcript and
`$AGENTMGR_HOME/antigravity/<name>/<incarnation-hash>/deliveries/` before deciding whether to cancel
or resubmit; AM cannot prove whether a process that crashed before acknowledging
had already acted on input. This is not an exactly-once execution guarantee.

`am interrupt <name>` sends SIGINT to agy's owned process group through the runner, holds queued work,
and records the eventual interruption/exit. It does not emulate native TUI
Escape. The CLI may exit; resume the saved conversation before continuing. If
agy survives SIGINT, an operator prompt or restart releases the hold. Mid-turn
`am send --now`, interrupt-with-message, and interruption by message receipt are
unsupported and fail clearly.

The runner owns a separate Unix process group. Shutdown retains TERM→KILL
escalation even after agy exits, and verifies ordinary group workers are stopped
before recording exited. Stop/remove/restart wait for authenticated cleanup
acknowledgement before killing or replacing the tmux pane. Missing runner or
cleanup evidence causes an explicit refusal. A process group is not a security
sandbox: a command that deliberately creates a separate session/group can escape
this boundary. AM does not claim containment of such detached workloads; agy's
configured execution policy remains the access boundary.

## Permissions and capability limits

AM **does not apply global `skipPermissions` to Antigravity**. It passes no
permission bypass or sandbox override and never writes agy's permission settings.
Google's configured policy remains authoritative; a role does not grant access.
This preserves existing Claude/Codex defaults without silently extending their
unattended permission bypass to a new runtime.

Google documents that headless tools needing approval can be **soft-denied**
while the run still exits successfully. The stream rejects `control_request` and
`control_response`, so AM has **no native approval relay** for this provider.
`WAITING` results and recognized permission-denial diagnostics mark
needs-attention and hold queued work. Diagnostic recognition is best effort;
there is no complete structured permission event contract in this adapter.
A successful response alone cannot prove every requested tool ran. Configure
scoped agy permissions directly after reviewing Google's
[permission documentation](https://antigravity.google/docs/permissions?tab=cli).

Unsupported capabilities are native approval answering, quota collection,
Antigravity remote-control links, native subagent observation/transcripts,
native subagent role-file export, native TUI slash commands, image attachments,
move/import/export, directory changes, rename, and cross-provider handoff.
Automatic idle report backstop is unsupported; explicit AM peer/report messaging
is available. API detail advertises unsupported controls; corresponding methods
reject them rather than using Claude/Codex implementations. Ordinary terminal
attachment, text transcripts/search, AM roles and queueing remain available.

AM's transcript is an owned JSONL projection of acknowledged input and final
assistant responses, stored under
`$AGENTMGR_HOME/antigravity/<name>/<incarnation-hash>/conversations/<conversation-hash>/transcript.jsonl` (default AM state root is
`~/.agent-manager`). It is not a full tool trace or an import of native agy
history. Records and their saved state bind the immutable agent incarnation and
validated native conversation. Reusing a name starts a separate namespace;
restoring the old state retains its old namespace. Adopting a conversation
exposes only turns recorded since adoption.
Google's [hooks docs](https://antigravity.google/docs/hooks/) identify native
storage under `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
and camelCase hook fields. AM does not read/write that native store or install
hooks. Existing `am hook` contracts cannot update Antigravity state or drain its
queue. Native subagent customization is documented separately by
[Google](https://antigravity.google/docs/cli/subagents); AM does not claim that
Claude/Codex role schemas or lifecycle hooks work there.

## Automated proof and pending live verification

Run all automated checks without real credentials/provider processes:

```sh
python3 scripts/test-isolated.py
python3 scripts/test-isolated.py tests/antigravity.test.ts tests/antigravityIntegration.test.ts tests/antigravitySurface.test.ts
```

The harness uses temporary HOME/state, an isolated tmux socket, and provider
stubs. Tests include actual fixture child processes, stdin/stdout NDJSON,
auth/exit/timeout failures, model/identity mismatch, malformed/oversized output,
queue acknowledgement/crash ambiguity, drafts, interrupts, and a real isolated
tmux launch/send/stop/resume/restart lifecycle. They validate AM behavior against
the documented contract; **they do not validate an installed authenticated agy**.

As of implementation, agy was absent on gapserver. No installation, sign-in,
paid model requests, production changes, pushes or PRs were authorized or run.
After separately authorizing installation/authentication **and model requests**:

1. Record `agy --version`, `agy --help` and `agy models`; compare the installed
   stream flags, explicit Argon slugs and permission policy with the sources.
2. Use a disposable project and temporary `AGENTMGR_HOME`; put a wrapper calling
   `tmux -L am-agy-validation-<unique-id>` first on PATH. Invoke the worktree's
   `bun src/index.ts` as AM, not the globally linked live checkout. Keep the
   credential HOME only after explicit sign-in authorization. This isolates AM
   state/tmux without changing the live daemon or fleet.
3. Launch `--antigravity --model <exact Argon slug>` with a harmless text-only
   prompt. Confirm init model echo, conversation ID, working→idle transition,
   recorded response and no unexpected billing route. Try an invalid slug;
   require an error and no fallback response.
4. Queue two distinguishable prompts during a slow turn. Verify ordered native
   acknowledgements/receipts. Type an unfinished draft in the attached runner;
   verify queued input remains pending and the draft survives. Submit the draft.
5. Stop/resume and restart with another available explicit Argon slug. Compare
   the saved conversation ID, remembered context, model and transcript across
   all launches. Test `--resume <id>` adoption and explicit `--continue` separately.
6. With a deliberately ungranted harmless tool request, verify soft-denial,
   needs-attention/queue hold and absence of a misleading approval button. Test
   SIGINT both during a turn and before acknowledgement; inspect unknown markers
   before any manual resubmission. Verify agy descendants terminate on stop.
7. Exercise API and hub create/queue/transcript flows plus an upgraded remote;
   verify an older remote is rejected before launch. Confirm unsupported controls
   fail explicitly. Use an isolated second test account/HOME to verify missing
   authentication exits promptly without exposing auth URLs/tokens.
8. Save sanitized evidence, then stop only the validation daemon/socket/agents
   and remove disposable state. Live verification remains pending until these
   checks run; do not infer it from fixtures.
