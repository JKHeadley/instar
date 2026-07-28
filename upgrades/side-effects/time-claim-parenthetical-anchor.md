# Side-effects review — TIME_CLAIM accepts a following parenthetical

**Change:** one character class in `ELAPSED_RE`. The `in` elapsed anchor now
accepts a following `(` or `[` as a boundary, alongside the existing
`, . ; : ) ] ! — – -` / end-of-string / `now`.

## Why — it missed two real fabrications on a live run

Found 2026-07-23 by testing the LIVE `/messaging/preflight` endpoint against
messages I had actually sent during an active time-boxed autonomous run.

The anchor accepted a CLOSING paren but not an OPENING one:

| text | before | after |
|---|---|---|
| `40 min in.` | extracts, flags | unchanged |
| `2h in)` | extracts, flags | unchanged |
| `40 min in (iteration 1)` | **extracts nothing** | extracts, flags |
| `1h10m in (iteration 1)` | **extracts nothing** | extracts, flags |

Both fabricated claims I sent used the parenthetical form — because annotating a
progress figure with `(iteration N)` is the natural way to write one. The claims
extracted to **nothing**, so the comparison against the live clock never ran at
all. Verified against the real endpoint: the same text with a period returns a
correct `TIME_CLAIM` advisory; with ` (` it returns `advisories: []`.

**Not a broken guard.** The wiring is correct and live — the dev-agent gate
resolves on, the relay posts `topicId` + kind, and conversational sends are
covered as the one deliberate non-automated exception. Only the boundary set was
incomplete.

## Deliberately NOT changed

**The 15-minute absolute tolerance floor.** My other fabricated claim — 57 minutes
when the truth was 45 — passed because a 12-minute error is inside
`DURATION_TOLERANCE_FLOOR_S`. That is working as designed (it stops the detector
nagging about rounding), and narrowing it is a judgment call with real
false-positive cost, so it is left alone and recorded instead. Worth knowing as a
property: early in a run the fixed floor covers a proportionally large range — at
14 minutes elapsed, any claim from 0 to 29 minutes passes.

## Risk analysis

**The accepted residual:** `2h in (CI queue)` reads as a PLACE and will now be
treated as an elapsed claim. Knowingly accepted. The signal is **advisory** — it
returns the message to the author with a note and never blocks — so a false
positive costs one re-read, while a false negative costs the operator a fabricated
time report. This session supplied direct evidence for which way that asymmetry
points.

**The boundary rule's purpose is preserved.** `in` followed by a WORD is still not
an anchor. Negative tests pin `3h in CI`, `in 2 hours`, `spent 2h in review`, and
the task-progress case `the migration is 80% done` — the widening must not reopen
any of those, and it doesn't.

**Blast radius:** one regex in one pure module. No authority (advisory only), no
write path, no config key, no schema, no migration surface. Fail-open behaviour on
every error path is untouched.

## Testing

`tests/unit/time-claim.test.ts` — 19 green (was 16). New: the two verbatim
fabricated messages are caught against a 14-minute clock; the square-bracket form;
all four previously-working boundaries unchanged; and four negatives pinning that
`in`-before-a-word is still rejected. Full advisory suite set: 41 green.
`tsc --noEmit` clean.

## Rollback

Revert. The anchor returns to its previous boundary set.
