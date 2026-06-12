# am UI improvements — proposal

Scope: the split-view hub (`src/commands/ui.ts`) and the shared picker engine
(`src/picker.ts`), as seen in the 38-column sidebar pane. Prioritized; each item
is independently shippable with `bunx tsc --noEmit` + `bun test` green.

Observed live in a 38-col sidebar pane against a 7-agent local fleet.

---

## P0 — Feedback/error visibility (Alex's top issue)

**What's wrong today.** Action results land in `feedback`, rendered as the footer
at the very *bottom* of the pane. Three concrete problems, all confirmed live:

1. **Errors look exactly like successes.** Every `feedback` string renders in the
   same yellow (`\x1b[33m`, picker.ts:255). Only the confirm-remove prompt is red.
   So `stop failed: …`, `handoff failed: …`, `attach failed: …`, and move errors
   are visually identical to `stopped x` / `handed off → y`. Nothing says "this
   one failed."
2. **The message is far from your eyes.** The footer is pinned to the last rows;
   the list + meta block sit at the top. With a short list in a tall pane the
   message is ~10–13 blank rows below the cursor — easy to miss entirely.
3. **Long errors get truncated.** `MAX_FEEDBACK_LINES = 6` at 38 cols ≈ 228 chars.
   ssh/stderr errors routinely exceed that and lose their meaningful tail behind
   an `…`.

**Proposed fixes.**

- **(a) Distinguish errors from successes by color + glyph.** Let handlers signal
  severity instead of returning a bare string. Smallest change that carries
  signal: a thin result type the picker understands —
  ```ts
  type Feedback = string | { text: string; level: "ok" | "warn" | "error" };
  ```
  Render `error` red with a `✕ ` prefix, `warn` yellow with `⚠ `, `ok` green with
  `✓ `. Handlers that already know they failed (the `… failed:` branches in
  fleetActions.ts / ui.ts) return `{level:"error"}`; the deferred-action reject
  path (picker.ts:443) defaults to `error`. Backwards compatible — a plain string
  stays `ok`/neutral.
- **(b) Put the message where the eyes are.** Render the active feedback as a
  banner directly **under the header / above the list** (one or two lines), not
  only at the bottom. The list shrinks by those rows while a message is live, then
  restores. Keeps the result adjacent to the action that produced it.
  - Alternative (smaller): keep it in the footer but draw a blank separator row
    above it and a left color-bar so it reads as a distinct region.
- **(c) Raise the truncation ceiling for errors and strip control chars.** Bump
  `MAX_FEEDBACK_LINES` to ~10 for `error`-level messages, and collapse `\r` /
  stray control bytes from ssh stderr before wrapping (today `\r` survives as
  whitespace via `split(/\s+/)` — fine, but tabs/backspaces don't).
- **(d) Timestamp/auto-age (optional).** Dim the banner after ~8 s so a stale
  message is visibly "old" and the fresh-vs-stale ambiguity goes away.

This is the one to do first; (a) + (b) are the high-value core.

---

## P1 — Status glanceability & the crowded right badge

**What's wrong.** The right badge packs host + provider + status + queue into one
string (fleet.ts:163): `@home codex working · 3 queued`. At 38 cols the label is
clipped to make room, and the *status word itself isn't colored* — only the leading
glyph hints at state, and the glyphs (`○ ◐ ● ⚠ ✔ ✕`) are monochrome too.

**Proposed fixes.**

- **Color the status glyph** (and only the glyph, to keep the row calm): working
  green, waiting/needs-attention yellow, idle dim, exited/dead dim-red. One color
  per state, applied as a `Cell.style` on just the prefix glyph so width math is
  untouched. This is the single biggest glanceability win for the least ink.
- **Trim the right badge to what's not already shown.** The status word is
  redundant with the glyph once the glyph is colored — drop it from `right` and
  keep host/codex/queue. Frees ~8 cols for the agent name.
- **Make queue depth pop.** `· 3 queued` → a compact `▸3` badge, colored when > 0,
  so a backed-up agent is obvious at a glance.
- Keep the full status (`status   working (3 queued)`) in the meta block where
  there's room — the badge is the glance, meta is the detail.

---

## P2 — The create flow (`n`: name / task / dir)

**What's wrong.** Three sequential single-line prompts (new-name → new-task →
new-dir) with no visible progress ("step 2 of 3"), no provider choice (codex vs
claude is only reachable from the CLI), and validation that only fires on Enter
(`name must be alphanumeric …` after you've typed the whole thing).

**Proposed fixes.**

- **Step indicator** in the prompt header: `new agent · name (1/3): …`.
- **Inline name validation** — reject the invalid keystroke (or show the hint live)
  instead of only on Enter.
- **Provider toggle** on the name step (e.g. Tab cycles claude/codex; show
  `· codex` in the header). Wire to the existing `provider` option in `NewOptions`.
- **Show the dir prefill clearly** and allow `Tab` to accept it. (Today the prefill
  is injected but there's no affordance that it's editable vs accepted.)
- Low risk, all additive to the existing `Mode` state machine.

---

## P3 — List behavior with many agents

**What's wrong.** Generally solid — name-tracked cursor, centered windowing, dim
section headers, exited hidden behind `a`. Gaps at scale:

- No scroll indicator: with a windowed list you can't tell there are more agents
  above/below. Add `↑3 more` / `↓5 more` affordances (or a scrollbar column).
- Section headers always render in fleet order; no within-section sort (e.g.
  working agents first, idle/exited last) — a busy host buries the active agent.
- `a` toggles *all* exited globally; no per-section collapse.

**Proposed fixes (pick as needed).**

- Sort within section by status priority (needs-attention > working > waiting >
  idle > exited), stable on name. Most impactful, smallest change.
- Add the `↑/↓ N more` edge hints when `start > 0` / `end < matches.length`.

---

## P4 — Footer ergonomics in 38 cols

The help line already wraps via `wrapTokens`, which is good. Smaller polish:

- The help spends 6+ lines when shown, shrinking the list. Consider a single
  `? help` hint by default that expands the full key list on demand, reclaiming
  rows for the list.
- Group keys by kind (nav / actions / lifecycle) so the wrapped block scans.

---

## Suggested order

1. ✅ **P0 (a)+(b)+(c)** — error color/glyph, banner under header, truncation
   ceiling. *(shipped — banner renders red ✕ / yellow ⚠ / green ✓ / dim, errors
   get 10 lines, ssh control bytes stripped.)*
2. ✅ **P1** — colored status glyph + trimmed badge + ▸N queue badge. *(shipped.)*
3. **P2** — create-flow step indicator + live validation + provider toggle.
4. **P3 / P4** — sort-within-section, scroll hints, collapsible help.

P0 + P1 are on `am/am-ui` (pushed); P2–P4 await a go-ahead.

Each lands as its own commit on `am/am-ui` with tsc + tests green. P0 and P1 add
unit tests (feedback level → SGR, status → color); the rest extend picker.test.ts.

## Coordination note

`agent-comms` is concurrently reworking inter-agent messaging in its own worktree
and may add a notifications/inbox surface to the picker. The P0 feedback-banner
work touches the same footer region — flag to Alex before landing P0 so the two
don't collide on the feedback channel.
