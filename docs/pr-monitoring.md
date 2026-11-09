# PR lifecycle monitoring

Agent Motel's daemon checks GitHub PRs every two minutes and queues a message to each owning agent when a PR merges, closes without merging, or reopens. Merge messages contain the repository, URL, merge SHA, and timestamp. Existing post-merge instructions decide what the agent does next; monitoring does not grant deployment or cleanup permission.

Register each PR as soon as it is opened, especially every layer of a stack:

```sh
am pr my-agent https://github.com/owner/repo/pull/123
am pr my-agent https://github.com/owner/repo/pull/124 https://github.com/owner/repo/pull/125
am pr my-agent                 # inspect tracked state as JSON
am pr gapserver:my-agent https://github.com/owner/repo/pull/126
```

The daemon also discovers PRs on live agents' current branches (except `main`/`master`) when the PR head belongs to the checkout's `origin` repository. Same-named branches from forks are excluded; use explicit registration when a fork PR is intentionally owned by the agent. Discovery retains previous associations when branches change. Explicit registration also covers layers created and switched away from between polls, shared checkouts, nonstandard remotes, and detached HEADs. PRs are keyed by repository and number; multiple owners each receive one event. The initial observation is quiet for open PRs and terminal events predating the agent's creation. A merge or closure since creation is reported even if first observed after the event.

Exited agents keep their registered PRs and queued messages without being resumed. Existing exited worktree agents can seed tracking from their recorded branch. Agents without a recorded branch need explicit registration. Removed agents are no longer monitored. Queue and monitor state follow normal agent rename/move handling. Each host runs its own watcher using its own `gh` credentials; an offline host catches up when its daemon returns. Fleet summary and hub detail carry the owning host's last observed state; unreachable hosts remain marked unreachable.

`am summary` includes PR states and short merge SHAs. Exited agents with tracked PRs and queued messages appear under “Exited with queued messages”; queues can also contain non-PR messages. `am summary --json` and the hub's existing summary API include monitor state and lookup errors. The picker detail shows up to three PRs plus a remaining count.

Set `prPollSeconds` in Agent Motel's config to change the cadence (`120` by default, `0` disables, positive values have a 30-second floor). Restart the daemon through the normal operator workflow to apply it. No live daemon restart is part of this change. Polls start five seconds after daemon startup, never overlap, and limit parallel owners to four. Shared lookups are reused within a sweep. Merged PRs no longer require individual polling; current-branch discovery still checks for new PRs. Failed lookups preserve the last state and retry next sweep; successful layers still progress.

Transition IDs are durably persisted before inbox insertion. A durable queue receipt under the delivery lock makes restart recovery idempotent, even if the message was already consumed. Monitor bookkeeping preserves the agent activity timestamp, and failed initial discovery is retried rather than treated as an empty successful bootstrap. Registration and polling serialize with rename, removal, and move snapshots; a busy or moving owner returns a retry error instead of accepting an association that cannot travel. Desktop notifications are best effort and journaled as `pr` notifications with the owner identity; the owner inbox is the durable source. Ordinary inbox delivery respects existing provider behavior: Claude may read queued context between tools, other delivery paths wait for a usable prompt. The watcher never uses `--now`, interrupts a turn, or starts an exited agent.

## Alternatives and future events

Polling needs no public endpoint or repository webhook installation. Its latency is the interval plus sweep/request time, and its cost scales with active branches and unmerged registered PRs. GitHub CLI exposes [state and merge evidence](https://cli.github.com/manual/gh_pr_view).

Webhooks could reduce latency, but the current server has no GitHub webhook receiver. Deployment documentation provides an HTTPS/Caddy path, not proof of a configured public webhook endpoint or Cloudflare tunnel. A receiver would require signature validation, durable ingestion, repository/App installation, and reconciliation: [GitHub does not automatically retry failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

The [notifications API](https://docs.github.com/en/rest/activity/notifications) is tied to an authenticated user's subscribed/participating threads. It is not a complete lifecycle feed for an explicit set of agent-owned PRs. An operator-side `gh` wrapper can catch CLI merges but misses browser merges; a local Git hook does not observe GitHub's merge button.

Review comments, failing/green checks, and merge conflicts are intentionally deferred. They need opt-in policies, head-SHA-aware deduplication, and coalescing so transient CI or repeated comments do not continually wake agents. Merge, close, and reopen are the initial low-noise lifecycle events.
