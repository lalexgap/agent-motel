# PR lifecycle monitoring

Agent Motel's daemon checks GitHub PRs every two minutes and queues a message to each owning agent when a PR merges, closes without merging, reopens, or develops merge conflicts. Conflict alerts identify the GitHub head and are deduplicated until GitHub reports the conflict resolved or a different head conflicts. Unknown mergeability does not count as resolution. Existing post-merge instructions decide what the agent does next; monitoring does not grant merge, deployment, or cleanup permission.

Register each PR as soon as it is opened, especially every layer of a stack:

```sh
am pr my-agent https://github.com/owner/repo/pull/123
am pr my-agent https://github.com/owner/repo/pull/124 https://github.com/owner/repo/pull/125
am pr my-agent                 # inspect tracked state as JSON
am pr gapserver:my-agent https://github.com/owner/repo/pull/126
```

After a shepherd has finished with no unresolved medium or major findings, explicitly verify and announce readiness from the reviewed worktree:

```sh
am pr my-agent https://github.com/owner/repo/pull/123 --ready --dir /path/to/review-worktree
```

This command is fail-closed and read-only apart from Agent Motel's local notification marker. It requires the installed review-gate adapter to cover the exact local and GitHub head, required parent and security coverage, and a safe local base ref resolving to the repository branch's live Git ref. It reads the PR and live base branch twice, because a PR's `baseRefOid` can lag the branch tip, and requires an open, clean, mergeable PR with no requested changes and at least one successful CI status or check; a PR with no CI is not considered green. Pending, failed, skipped, neutral, unknown, malformed, or potentially truncated check results are withheld. It never fetches, restacks, writes GitHub state, or wakes the owner agent. A successful head is announced to the desktop/journal once; a later head needs a fresh shepherd verdict and invocation.

The daemon also discovers PRs on live agents' current branches (except `main`/`master`) when the PR head belongs to the checkout's `origin` repository. Same-named branches from forks are excluded; use explicit registration when a fork PR is intentionally owned by the agent. Discovery retains previous associations when branches change. Explicit registration also covers layers created and switched away from between polls, shared checkouts, nonstandard remotes, and detached HEADs. PRs are keyed by repository and number; multiple owners each receive one event. The initial observation is quiet for open PRs and terminal events predating the agent's creation. A merge or closure since creation is reported even if first observed after the event.

Exited agents keep their registered PRs and queued messages without being resumed. Existing exited worktree agents can seed tracking from their recorded branch. Agents without a recorded branch need explicit registration. Removed agents are no longer monitored. Queue and monitor state follow normal agent rename/move handling. Each host runs its own watcher using its own `gh` credentials; an offline host catches up when its daemon returns. Fleet summary and hub detail carry the owning host's last observed state; unreachable hosts remain marked unreachable.

`am summary` includes PR states and short merge SHAs. Exited agents with tracked PRs and queued messages appear under “Exited with queued messages”; queues can also contain non-PR messages. `am summary --json` and the hub's existing summary API include monitor state and lookup errors. The picker detail shows up to three PRs plus a remaining count.

Set `prPollSeconds` in Agent Motel's config to change the cadence (`120` by default, `0` disables, positive values have a 30-second floor). Restart the daemon through the normal operator workflow to apply it. No live daemon restart is part of this change. Polls start five seconds after daemon startup, never overlap, and limit parallel owners to four. Shared lookups are reused within a sweep. Merged PRs no longer require individual polling; current-branch discovery still checks for new PRs. Failed lookups preserve the last state and retry next sweep; successful layers still progress.

Transition IDs are durably persisted before inbox insertion, including when recovering pending events after a failed state sync. A durable queue receipt under the delivery lock makes restart recovery idempotent, even if the message was already consumed. Monitor bookkeeping preserves the agent activity timestamp. Initial discovery retries Git and GitHub failures until a lookup succeeds, including a successful empty result. Registration and polling serialize with rename, removal, and move snapshots; a busy or moving owner returns a retry error instead of accepting an association that cannot travel. Desktop notifications are best effort and journaled as `pr` notifications with the owner identity and canonical GitHub PR URL, allowing supported notification backends and remote relays to open the PR when clicked. Legacy journal entries and pending events without a URL remain valid. Invalid or non-GitHub URLs are shown as text without a click action, and collapsed relay summaries never choose an arbitrary notification URL. The owner inbox is the durable source. Ordinary events wait for the parent turn boundary and a usable prompt before delivery. The watcher never uses `--now`, interrupts a turn, or starts an exited agent.

On macOS, clickable PR notifications require terminal-notifier 3 or newer and notification permission for terminal-notifier. If it is unavailable, denied, or exits unsuccessfully, Agent Motel falls back to the existing iTerm or AppleScript notification path; those fallback banners do not provide the PR click action. A custom `notifyCommand` receives the validated URL in `AM_URL`. Notification permission is currently denied in the development environment, so the clickable banner has not been verified there.

## Alternatives and future events

Polling needs no public endpoint or repository webhook installation. Its latency is the interval plus sweep/request time, and its cost scales with active branches and unmerged registered PRs. GitHub CLI exposes [state and merge evidence](https://cli.github.com/manual/gh_pr_view).

Webhooks could reduce latency, but the current server has no GitHub webhook receiver. Deployment documentation provides an HTTPS/Caddy path, not proof of a configured public webhook endpoint or Cloudflare tunnel. A receiver would require signature validation, durable ingestion, repository/App installation, and reconciliation: [GitHub does not automatically retry failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

The [notifications API](https://docs.github.com/en/rest/activity/notifications) is tied to an authenticated user's subscribed/participating threads. It is not a complete lifecycle feed for an explicit set of agent-owned PRs. An operator-side `gh` wrapper can catch CLI merges but misses browser merges; a local Git hook does not observe GitHub's merge button.

Review-comment notifications and general failing/green-check alerts remain deferred. Readiness uses an explicit finished-shepherd declaration instead of inferring completion from CI, while conflict alerts use head-aware episode deduplication so repeated polls do not continually wake agents.
