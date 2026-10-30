# Inspecting the lifecycle audit trail

Each host appends JSON records to `$AGENTMGR_HOME/logs/lifecycle-audit.jsonl` (default `~/.agent-manager/logs/lifecycle-audit.jsonl`). These are host-local files: inspect the executing host, or use `ssh gapserver` for gapserver's trail. The log survives agent removal, trash expiry and GC. It is separate from the size-capped `daemon.log`; am never truncates or automatically expires it. Archive it according to your retention policy. File permissions are restricted to `0600` on every append.

An incomplete final line (for example, after a short write) blocks later lifecycle operations before they act. Archive the intact trail by moving it aside before the next operation; am will create a new trail. Do not truncate or repair retained evidence. Appends are serialized using the sibling `lifecycle-audit.jsonl.lock`; this lock file must remain in place, including when archiving.

For example, on the host where the agent ran:

```sh
audit="${AGENTMGR_HOME:-$HOME/.agent-manager}/logs/lifecycle-audit.jsonl"
jq -c 'select(.target == "my-agent")' "$audit"
jq -c 'select(.action == "stop" and .phase == "requested")' "$audit"
tail -f "$audit"
```

Every record contains an ISO UTC `timestamp`, `requestId`, executing `host`, process `pid`, OS `uid`/`user`, `target`, `action`, `phase`, and a `source`/`actor`/`auth`. Known entry points add a route template. SSH and HTTP include the peer address when available. Forwarded commands also include `targetHost`. The request and outcome of one operation share `requestId`; filter it to examine that operation:

```sh
jq -c --arg id 'REQUEST-UUID' 'select(.requestId == $id)' "$audit"
```

| Action | Meaning |
| --- | --- |
| `stop-request` | An authenticated HTTP/web stop request, including invalid bodies, missing agents and refusals |
| `stop` | Explicit stop from CLI, picker, hub, API or internal caller |
| `stop-if-idle` | Conditional stop attempt; `refused` with `busy`, `queued` or `in_turn` means no stop was performed by that attempt |
| `restart` | Restart of the saved conversation, including tmux pane respawn |
| `move`, `cd` | Source shutdown for relocation or directory change |
| `remove`, `move-cleanup`, `run-cleanup`, `gc` | Removal and its purpose |
| `session-ended` | Provider session-end hook observed an exit |
| `session-disappeared` | Daemon observed a missing tmux session; its cause is unknown |

`requested` is flushed to disk before termination/removal. `completed` means the operation returned successfully; `failed` means it threw or the SSH command failed. `observed` records an exit observation, not a stop request. A request without an outcome may mean the requesting process died or the outcome write failed; it does not prove termination succeeded. If the initial audit write fails, stop/remove/restart aborts before termination. Observation write failures emit a warning and leave lifecycle processing running.

Attribution follows the available authentication:

- CLI: local OS account, plus `AGENTMGR_AGENT` as the claimed invoking agent when present. Agent names are process context, not separately authenticated human identities. `source` distinguishes CLI, interactive picker/hub and internal calls.
- HTTP: `shared-bearer` or `browser-session` actor and authentication method. am has shared credentials, not individual user identities. The peer is the direct socket peer (possibly a reverse proxy); forwarded client headers are not trusted.
- SSH: receiving OS account and SSH connection peer. The forwarding host also records the originating context and target host before invoking SSH. Inspect both hosts and correlate target/action/time; request IDs are local to each operation and are not propagated across SSH. The destination must run an updated am to produce its own audit records. A forwarding `completed` reports the SSH command's result, not an independent observation of the target process.

Nested HTTP, conditional-stop, lifecycle and forwarding records describe different layers of the same request, so multiple records are expected. Only authenticated, origin-accepted API requests enter this trail. Tokens, cookies, credentials, raw argv, request bodies, query strings, task text and raw errors are excluded. Safe refusal reason codes may appear.

The audit cannot retrospectively identify an old stop. Direct external `tmux kill-session`, signals, systemd shutdowns and host crashes bypass am request logging; the daemon may later record `session-disappeared`, without proving whether it was a crash or an external kill. This is an operational audit, not a tamper-proof ledger against someone who can write the local account's files.
