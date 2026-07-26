<!-- bump: patch -->

## What Changed

**`GET /metrics/learning-velocity` now counts work that FINISHED, not work that was filed.**

The metric answering "are we actually learning and adapting?" counted every evolution action at its
`createdAt`. Verified 2026-07-25: 739 of 771 "learning events" (96%) were items merely FILED, and on
the real queue 494 of those carry the abandonment sweep's own resolution text. So the metric had
inverted — **the faster work was abandoned, the higher the adaptability score climbed.** It read
88/100 "accelerating" on the morning the operator halted all work because the opposite was visibly
true.

An action now contributes a learning event only when `status === 'completed'`, stamped at
`completedAt` (falling back to `updatedAt`). Pending, in-progress, cancelled and auto-abandoned
actions contribute nothing.

Measured before/after on a real queue, 30-day window, rule change only: **784 events → 18** (of
1,288 considered: 743 pending, 494 auto-abandoned, 29 cancelled, 2 in progress).

Two doors deliberately shut: a `completed` action with no completion timestamp is EXCLUDED rather
than back-dated to `createdAt` (which would re-import the filing bias), and the window still
excludes old completions.

`computeLearningVelocity` itself is untouched — only the route's event gathering changed.

## What to Tell Your User

Your adaptability score will drop, in most cases sharply, and the new number is the honest one. The
old one was largely a count of how fast items were being filed. The response now states the counting
rule and itemises what was excluded and why, so a low score reads as "little has finished recently"
rather than "we have stopped learning" — those call for opposite responses.

## Summary of New Capabilities

- `counting` — the rule in one line, travelling with the number.
- `evolutionActions` — `{ considered, counted, excluded }` by reason, with `auto-abandoned` named
  specifically (the largest bucket, and the one the old metric scored as learning).

## Evidence

- `tests/integration/learning-velocity-routes.test.ts` — 7 tests. Three existing cases rewritten
  (they asserted filed items count as learning — a specification of the inversion), three added:
  the real queue in miniature (5 filed-or-abandoned + 1 completion → exactly 1 event); a completion
  with no timestamp excluded rather than back-dated; a completion outside the window excluded by
  date while still visible in `counted`.
- `tests/e2e/learning-velocity-lifecycle.test.ts` — the counting rule and accounting survive the
  production initialization path.
- `tests/unit/LearningVelocityScorer.test.ts` — unchanged and passing: the pure scorer's contract
  did not move.
