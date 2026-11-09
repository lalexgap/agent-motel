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
  bound each remote's captured stdout/stderr at 2 MiB and its runtime at the
  remaining shared deadline. At most 16 hosts are attempted. Remote failures,
  invalid replies, and remote partial results identify the host. Old peers
  returning arrays remain usable but are marked `legacy-completeness-unknown`;
  peers rejecting the flag appear unavailable. No claim of complete coverage
  is made for either case.
- The terminal picker uses the same scanner with a 100 ms budget and shows
  `partial`. Browser conversation search has its own bounded implementation
  and existing partial/unavailable-host response; its API is unchanged.

There are no date/role indexes or ranking redesign in this change.

## Ranked approaches

### Tier 1b — picker `/` chat-search mode  (same PR, separable)
A `/` mode in `picker.ts` that shells `am search --json <q>` async (debounced),
maps results → `PickerItem` with the snippet in `meta`, and on Enter runs the
result's action (jump/resume/restore/`new --resume`). Turns the hub into a
chat-searchable picker **without an index**. Medium risk (picker is the most
complex file); ship only if the CLI lands clean, else split to a follow-up.
Note: we do NOT make the live `visibleItems` filter run rg per keystroke — that
mode is explicit and async.

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

## Recommendation

Ship **Tier 1** (`am search`, bounded scanning, zero deps, local + `--all` + `--fleet`)
now; include **Tier 1b** (picker `/`) in the same PR if it lands cleanly, else as
a fast follow. Hold **Tier 2** (semantic) until we see full-text fall short.

## Open questions for sign-off

1. Default scope — registered+trash with `--all` opt-in (my pick), or search all
   history by default?
2. Picker `/` mode in this PR, or CLI-only first?
3. Semantic later at all, and if so API (cost) vs local (dep) for the embedder?
