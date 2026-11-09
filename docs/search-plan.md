# Search across agents (and their chat text) — plan

Goal (user's words): **search across all agents easily; also search the chat
text, maybe semantic; make it easiest to pick up an old session an agent was
running.**

## What already exists (touch-points)

- `src/transcript.ts` — `locateTranscript(agent)` finds the native JSONL
  (`~/.claude/projects/<slug>/<id>.jsonl`, `~/.codex/sessions/.../rollout-*-<id>.jsonl`);
  `parseTranscript()` → `Turn[]` (user/assistant/tool), already strips sidechain,
  meta, tool noise, and harness prefixes. This is the clean text source.
- `src/commands/ls.ts` — `agentRows()` / `AgentRow`, `displayStatus()`.
- `src/fleet.ts` — federation pattern: remote rows via `am ls --json --local-only`
  over ssh (`fetchRemoteRows`). `PickerItem.search` is today just
  `task + dir + provider + host` substring.
- `src/picker.ts` — `visibleItems()` filters by substring over `name + search`.
- `src/state.ts` — `listAgents()`, `resolveAgent()`, `agentSessionId()`.
- `src/trash.ts` — `listTrashed()` (removed-but-recoverable agents).
- Action mapping for "pick it up":
  - live session → `am j <name>`
  - registered + exited → `am resume <name>`
  - in trash → `am restore <name>`
  - **any historical session by id → `am new <name> --resume <session-id>`**
    (confirmed in `providers.ts`: both claude and codex support resume-by-id).

## Current bounds and compatibility

The original 46 ms measurement covered `rg -l` on a 265 MB / 187-file corpus.
It was a historical filename-only benchmark, not a latency guarantee for full
conversation extraction. Buffering `rg --json` output, or reading whole files
in the fallback, was unsafe: a matching record or accumulated output could
exceed the runtime's string capacity. Parsing only matching lines is **not**
safe at any size.

Search now uses one bounded chunk scanner regardless of whether ripgrep is
installed. It retains at most one 1 MiB JSONL record and reads 64 KiB chunks.
Oversized records are skipped through their next newline; subsequent smaller
messages still match. The local scan stops at 64 MiB read, 250,000 records,
10,000 corpus files, or the shared 8-second search deadline. History discovery
also caps visited directory entries at 100,000 per provider root. Synchronous
filesystem/agent discovery operations can overrun the wall-clock deadline;
checks between operations stop further work. This is a work budget, not a
hard real-time guarantee for slow disks.

Transcript lookup rejects nonregular explicit paths before probing them. Legacy
Antigravity provenance validation is capped at 1 MiB (or a lower requested
line/byte budget); larger legacy files are skipped with `lookup-bytes`, without
relaxing incarnation/conversation checks. Missing known transcripts and failed
provenance checks report `transcript-unavailable`. Scan byte counters exclude
lookup probes; agents with no recorded transcript or session yet are skipped.

`--limit` caps returned results (default 20, maximum 1,000), **not scan work**.
The separate budgets above cap scan work. Each file also stops after 50 raw
matching records by default. Ranking remains live agents, scope, recency, then
match count, within the searched portion. Output results are capped at 2 MiB
of compact JSON. Metadata adds a small amount of overhead. Any skipped records,
exhausted budget, unreadable transcript, or omitted results marks the response
partial; counts and ranking then describe only the searched portion.

`am search <query> [--all] [--fleet] [--limit N] [--json] [--metadata]`:

- Default scope remains registered agents plus trash; `--all` includes history.
- `--json` still returns `SearchResult[]`. Partial warnings go to stderr for
  both JSON and text. Empty partial results say only that the searched portion
  had no matches.
- `--json --metadata` opts into `{ results, metadata }`, including local scan
  counters/reasons and per-host completeness. The in-process `search()` result
  remains an array with an additive `.metadata` property (not serialized by
  `JSON.stringify`); callers must inspect it to determine completeness.
- Fleet queries request the envelope, pass the requested result limit, and
  bound each remote's captured stdout/stderr at 2 MiB plus a fixed 4 KiB
  allowance for the local-only metadata envelope and trailing newline. The
  result-array budget remains 2 MiB; runtime uses the remaining shared deadline.
  At most 16 hosts are attempted. Remote failures,
  invalid replies, and remote partial results identify the host. Old peers
  returning arrays remain usable but are marked `legacy-completeness-unknown`;
  peers rejecting the flag appear unavailable. No claim of complete coverage
  is made for either case.
- The terminal picker uses the same scanner with a 100 ms budget and shows
  `partial`. Browser conversation search has its own bounded implementation
  and existing partial/unavailable-host response; its API is unchanged.

There are no date/role indexes or ranking redesign in this change.

## Ranked approaches

### Tier 1b — picker `/` chat-search mode (implemented)

The explicit `/` mode calls the local scanner synchronously as the query changes,
with a 100 ms scan budget and a 100-result cap. It filters the picker's current
items to matching local registered agents, preserves search rank, and displays
the lead snippet. It does not shell out or search remote/history rows. The
prompt shows `partial` during entry and after Enter when a budget or lookup
failure limits coverage. Enter keeps the matched list for normal picker
selection; Escape clears the chat query. Filesystem calls can still overrun
the scan deadline as described above.

### Tier 2 — semantic search  ⏸ follow-up PR, only if full-text proves thin
- Embedder, pluggable via config: **API-first** (`voyage-3-lite` or OpenAI
  `text-embedding-3-small` — cheap, trivial deps = just `fetch`, needs a key +
  network). Local model (transformers.js / fastembed) avoids cost but adds a big
  dep + model download — not worth it for a single-user CLI v1.
- Store: **`bun:sqlite`** (built into Bun, zero dep). `chunks(session_id, file,
  turn_idx, role, text, ts, mtime, vec BLOB)`; brute-force cosine in JS (a single
  user is low-thousands of chunks → <100 ms). `sqlite-vec` only if it ever grows.
- `am index [--all]`: incremental embed of new/changed turns (track file mtime +
  last turn offset), skipping tool noise. Default semantic search auto-indexes
  only the small registered corpus; `--all` history is opt-in (embedding 265 MB
  is real tokens = cost/minutes).
- Surface: `am search --semantic <q>`, optional hybrid rank with full-text.
- **Why defer:** recurring API cost or a heavy local dep, plus index-freshness
  and complexity, until bounded full-text search proves insufficient.

## Follow-up

The CLI and picker full-text search are implemented. Keep semantic search
deferred until bounded full-text search proves insufficient. Default scope
remains registered agents plus trash, with history and fleet queries opt-in.
