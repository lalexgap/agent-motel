# PR150 terminal fixture captures

Head: `c7ce54188ae61d9011fd6e47017778798ec9b506`; base: `df7b071378af381399ce4fa5b00b9034f6cd25c1`.

After-only captures of the real picker renderer at 100 columns × 30 rows. Stop/remove promises are mocked; no SSH or real agent lifecycle commands run. The fixture asserts two-step removal confirmation and navigation to `fixture:two` while `fixture:one` remains pending, then resolves with the actual hub timeout text. ANSI output is replayed through pyte and rasterized; this verifies terminal states, not live remote behavior.

| State | Capture |
|---|---|
| Stop pending | [PNG](stop-pending.png) |
| Navigate during stop | [PNG](stop-navigation.png) |
| Stop timeout | [PNG](stop-timeout.png) |
| First removal press, confirmation only | [PNG](remove-confirmation.png) |
| Removal pending | [PNG](remove-pending.png) |
| Navigate during removal | [PNG](remove-navigation.png) |
| Removal timeout | [PNG](remove-timeout.png) |

Reproduction: `python3 scripts/test-isolated.py /tmp/pr150-shepherd-PSv1li/capture.test.ts`, followed by `render.py` with pyte/Pillow installed outside the repository. The fixture source, renderer, and raw `.ansi` streams accompany these images. HOME, state and tmux are private to the isolated runner. Before: n/a, incremental change.

Independent image check: PASS by native checker `01a1c126-7505-77f2-a4a2-b77829f00144`. All seven PNGs inspected: confirmation, pending text, changed selection, and full timeout messages visible; no clipping, overlap, or selection defects. Pending text is low contrast but readable. Behavioral assertions, rather than screenshots alone, establish that first removal press does not execute the action.
