# PR148 terminal evidence

After captures for commit `d8f04302efb8377cc53fd675fcbbcd2c1e86d34f`.

The real picker runs with isolated fixture state and mocked terminal input/output. It scans an oversized record followed by a matching message. Raw ANSI frames are rendered through xterm.js at 120 columns by 24 rows; no real fleet is accessed.

- `picker-typing.png`: query input shows `needle · partial` with a visible match.
- `picker-committed.png`: applied search shows `1 matches · partial · esc clears` with the matching snippet.

Capture command: `AM_SEARCH_EVIDENCE_DIR=<private-output> python3 scripts/test-isolated.py tests/search-picker.test.ts`.

Before: not captured; incremental label change.
