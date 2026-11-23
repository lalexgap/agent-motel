# Notification audit: gapserver

Audit window: `2026-11-16T16:23:00Z` through `2026-11-23T16:23:00Z` (the preceding seven days at measurement time). Notification message and title contents were not reported.

## Findings

The gapserver notification journal contains **740 notification attempts** in the observable part of the window:

| Kind | Attempts | Share |
|---|---:|---:|
| idle | 459 | 62.0% |
| pr | 145 | 19.6% |
| decision | 122 | 16.5% |
| attention | 13 | 1.8% |
| share | 1 | 0.1% |
| **Total** | **740** | **100.0%** |

Idle repeats were measured cumulatively against the same agent's immediately preceding idle attempt inside the window:

| Maximum interval | Repeats | Share of 459 idle attempts |
|---|---:|---:|
| 60 seconds | 12 | 2.6% |
| 300 seconds | 114 | 24.8% |
| 600 seconds | 197 | 42.9% |

The busiest agents were:

| Agent | Total | Attention | Idle | Share | PR | Decision |
|---|---:|---:|---:|---:|---:|---:|
| search-eval-and-redesign | 175 | 0 | 124 | 0 | 20 | 31 |
| search-mcp-rollout | 102 | 0 | 77 | 1 | 21 | 3 |
| mcp-search-tool-shape | 55 | 0 | 34 | 0 | 5 | 16 |
| concierge | 29 | 0 | 29 | 0 | 0 | 0 |
| grading-algorithms-report | 27 | 3 | 9 | 0 | 13 | 2 |
| self-serve-checkout-tracking | 25 | 2 | 7 | 0 | 15 | 1 |
| wow-vendor-sniper | 23 | 0 | 12 | 0 | 1 | 10 |
| ads-mcp-usage-report | 20 | 2 | 11 | 0 | 4 | 3 |

The complete per-agent table and repeat breakdown are reproducible with the script below. The top three agents account for 235 idle attempts (51.2%); `concierge` adds 29 idle attempts.

<details>
<summary>Complete per-agent snapshot (51 rows)</summary>

| Agent | Total | Attention | Idle | Share | PR | Decision |
|---|---:|---:|---:|---:|---:|---:|
| search-eval-and-redesign | 175 | 0 | 124 | 0 | 20 | 31 |
| search-mcp-rollout | 102 | 0 | 77 | 1 | 21 | 3 |
| mcp-search-tool-shape | 55 | 0 | 34 | 0 | 5 | 16 |
| concierge | 29 | 0 | 29 | 0 | 0 | 0 |
| grading-algorithms-report | 27 | 3 | 9 | 0 | 13 | 2 |
| self-serve-checkout-tracking | 25 | 2 | 7 | 0 | 15 | 1 |
| wow-vendor-sniper | 23 | 0 | 12 | 0 | 1 | 10 |
| ads-mcp-usage-report | 20 | 2 | 11 | 0 | 4 | 3 |
| amp-migration-audit | 16 | 0 | 8 | 0 | 6 | 2 |
| golden-search-set | 16 | 0 | 16 | 0 | 0 | 0 |
| search-optimizer | 16 | 0 | 16 | 0 | 0 | 0 |
| homepage-billboard-slots | 12 | 0 | 5 | 0 | 4 | 3 |
| review-rajiv-mcp-prs | 12 | 0 | 8 | 0 | 0 | 4 |
| search-optimizer-claude | 12 | 0 | 11 | 0 | 0 | 1 |
| am-cleanup-action | 11 | 0 | 6 | 0 | 4 | 1 |
| creative-assist-revive | 11 | 0 | 3 | 0 | 6 | 2 |
| abandoned-form-experiment-owner | 10 | 0 | 3 | 0 | 3 | 4 |
| es-upgrade-embeddings | 10 | 2 | 2 | 0 | 2 | 4 |
| homepage-ads-promo-widen | 10 | 0 | 4 | 0 | 3 | 3 |
| adblock-xpath-rule | 9 | 0 | 2 | 0 | 4 | 3 |
| chatgpt-plugin-exclude-checkout | 9 | 0 | 6 | 0 | 3 | 0 |
| search-test-set | 9 | 0 | 9 | 0 | 0 | 0 |
| inquiry-status-model | 8 | 0 | 4 | 0 | 4 | 0 |
| (none) | 7 | 4 | 0 | 0 | 0 | 3 |
| auto-reply-advertiser-faq | 7 | 0 | 3 | 0 | 1 | 3 |
| status-skill-proposal | 7 | 0 | 4 | 0 | 2 | 1 |
| abandoned-form-video-views | 6 | 0 | 4 | 0 | 1 | 1 |
| ad-form-agency-fields | 6 | 0 | 1 | 0 | 5 | 0 |
| es-reindex-diagnosis | 6 | 0 | 2 | 0 | 1 | 3 |
| gauge-aeo-sponsor | 6 | 0 | 3 | 0 | 2 | 1 |
| mcp-search-live-test | 6 | 0 | 6 | 0 | 0 | 0 |
| search-unification | 6 | 0 | 4 | 0 | 2 | 0 |
| homepage-promo-copy-update | 5 | 0 | 0 | 0 | 2 | 3 |
| portal-in-review-stuck | 5 | 0 | 2 | 0 | 2 | 1 |
| side-issue-log-skill | 5 | 0 | 4 | 0 | 1 | 0 |
| ad-selection-dedupe-audit | 4 | 0 | 1 | 0 | 0 | 3 |
| launch-outreach-review | 4 | 0 | 1 | 0 | 1 | 2 |
| master-unit-tests-failure | 4 | 0 | 1 | 0 | 2 | 1 |
| sentry-company-grade-worker | 4 | 0 | 2 | 0 | 2 | 0 |
| ads-mcp-panels-placement | 3 | 0 | 2 | 0 | 1 | 0 |
| am-app-cpu-usage | 3 | 0 | 1 | 0 | 0 | 2 |
| dmarc-enforcement | 3 | 0 | 1 | 0 | 0 | 2 |
| mcp-search-landscape | 3 | 0 | 3 | 0 | 0 | 0 |
| mcp-search-v2-improvements | 3 | 0 | 3 | 0 | 0 | 0 |
| billboard-distinct-creatives | 2 | 0 | 0 | 0 | 2 | 0 |
| vector-storage-review | 2 | 0 | 2 | 0 | 0 | 0 |
| web-ad-impression-drop | 2 | 0 | 1 | 0 | 0 | 1 |
| amp-audit-probe | 1 | 0 | 0 | 0 | 0 | 1 |
| mcp-search-staff-test | 1 | 0 | 1 | 0 | 0 | 0 |
| stop-inquiry-draft-digest | 1 | 0 | 1 | 0 | 0 | 0 |
| third-billboard-inventory | 1 | 0 | 0 | 0 | 0 | 1 |

</details>

## Coverage and interpretation

- `~/.agent-manager/notifications.jsonl`: 740 valid rows, zero invalid rows, all for host `gapserver`. Retained timestamps are `2026-11-16T18:48:48.645Z` through `2026-11-23T16:21:41.022Z`; no records are retained for the first 2h25m of the requested window. That could mean no attempts occurred or older records were trimmed, so full-window completeness cannot be established. The journal is size-bounded (256 KiB, trimming to recent entries after the limit); this file was 220,042 bytes during the audit. The counts are exact for retained records and may be lower bounds for the requested window.
- `~/.agent-manager/logs/lifecycle-audit.jsonl`: coverage is `2026-10-30T22:46:51.249Z` through `2026-11-23T16:12:51.778Z`. It has 623 rows in the exact audit window, including 111 daemon-sourced rows: 49 `gc/requested`, 49 `gc/completed`, and 13 `session-disappeared/observed`. It contains lifecycle operations, not notification delivery receipts.
- The `am-daemon.service` user journal has 54 rows in the window, from `2026-11-16T16:34:28.199523Z` through `2026-11-23T12:02:11.080481Z` (52 informational, 2 notice). It contains no durable OS-delivery acknowledgements.
- `~/.agent-manager/logs/daemon.log` is a stale legacy text log (mtime `2026-10-26T21:50:47.480023Z`) and does not overlap the audit window.

These are **notification attempts/journal entries**, not delivered OS notifications. The implementation journals before calling the display path. On gapserver, `notifyCommand` is not configured and `notify-send` is unavailable; a remote relay may still attempt display on another host, but no acknowledgement of banner display or user receipt is written back to the audited logs.

Focused-agent suppression is **explicitly unavailable to measure**: neither the notification journal nor lifecycle audit records selected-agent or focused-window state, and the available daemon logs contain no such telemetry. The counts cannot establish how many attempts occurred while Alex was viewing the agent.

## Reproduce

Run on gapserver from this repository:

```sh
python3 scripts/notification-audit.py --end 2026-11-23T16:23:00Z
```

The script reads notification metadata, lifecycle metadata, daemon journal metadata, and legacy daemon-log file metadata. It intentionally never emits notification titles or messages. Omit `--end` to audit the seven days preceding the current time; use `--days`, `--notifications`, `--lifecycle`, or `--daemon-log` to change inputs.
