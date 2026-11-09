# Troubleshooting

Start with the symptom below. For setup, see the [quick start](../README.md#quick-start), [web front desk](web-ui.md), and [remote fleets](../README.md#remote-fleets). Integrations have a separate [HTTP API reference](../README.md#http-api).

- [Agent is waiting at folder trust](#folder-trust)
- [Resume must reopen the right conversation](#exact-resume-identity)
- [Remote feature is unavailable](#remote-version-mismatch)
- [Agent stopped or disappeared](#lifecycle-audit)
- [Run tests without touching the fleet](#isolated-tests)

## Folder trust

Inspect the agent with `am peek <name>` or open its terminal to read the actual prompt. Claude folder pretrust applies only with `skipPermissions` enabled and `pretrustClaudeDirs` not disabled. It preserves an existing trust answer and never trusts the home directory or its ancestors. A worktree uses the main checkout's Git root. Do not broaden trust to clear an unfamiliar prompt; review the specific directory in the provider UI.

See [provider hooks and folder trust](../README.md#how-it-works) for the config and trust ledger. Codex's first managed launch also asks you to trust its installed hooks.

## Exact resume identity

Check `am ls --json` and `am transcript <name> --json` on the host that owns the agent, and confirm the provider, working directory and conversation before resuming. Transcript JSON includes the resolved `sessionId`. Before `am resume <name>`, confirm that saved identity; a missing identity needs investigation, not a guessed replacement with the provider's latest conversation.

When adopting a known conversation, use `am new <name> --resume <session-id>` with the matching provider and directory. Bare `--resume` opens the Claude/Codex session picker; `--continue` explicitly selects the provider's latest conversation and is not an exact-identity repair. See [preserve and hand off work](../README.md#preserve-and-hand-off-work) and [Antigravity resume limits](antigravity.md#launch-and-conversation-identity).

## Remote version mismatch

A reachable host can still lack a newer command or API capability. Preserve the actual error (`remote_too_old`, unsupported flag, or missing command); do not treat it as an empty result. Compare the installed AM revisions and provider versions on both hosts, including the executable reached by SSH. Upgrade the older installation before retrying a feature it does not support.

See [remote setup](../README.md#remote-fleets), [reverse SSH verification](reverse-ssh.md#4-verify-on-the-server), [remote subagent requirements](web-ui.md), and [service ownership](service-lifecycle.md) when an old service process remains after an update.

## Lifecycle audit

Inspect the executing host's `~/.agent-manager/logs/lifecycle-audit.jsonl` (or `$AGENTMGR_HOME/logs/lifecycle-audit.jsonl`). Correlate target, timestamp and request ID; a requested action is not proof it completed. An observed disappearance does not identify who stopped it, and old stops cannot be reconstructed retroactively.

The [lifecycle audit guide](lifecycle-audit.md) includes read-only queries, attribution limits and log retention guidance.

## Isolated tests

From the checkout, run:

```sh
python3 scripts/test-isolated.py tests/catalog.test.ts tests/roles.test.ts
python3 scripts/test-isolated.py
```

The [runner](../scripts/test-isolated.py) supplies a temporary HOME, AM state, tmux socket and provider stubs. Pass test paths or Bun test flags after the script name. Never run plain `bun test` against a live fleet's HOME, and never reproduce lifecycle or cleanup bugs with live agents. See [development](../README.md#development).
