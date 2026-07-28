# Side-Effects Review — learning velocity counts finishing, not filing (ACT-1244)

## Summary of the change

`GET /metrics/learning-velocity` counted EVERY evolution action at its `createdAt`, so the metric
answering "are we learning?" was almost purely a measure of FILING RATE. Verified 2026-07-25: 739 of
771 events (96%) were filed items; on the real queue 494 of those carry the sweep's resolution
"Abandoned without active tracking since creation date". The metric read 88/100 "accelerating" on
the morning the operator halted work because the opposite was visibly true — **the faster work was
abandoned, the higher the score climbed.**

An action now contributes a learning event ONLY when `status === 'completed'`, stamped at
`completedAt` (falling back to `updatedAt`). Everything else is excluded and ACCOUNTED FOR by
reason. The response gains `counting` (the rule, in one line) and `evolutionActions`
(`considered` / `counted` / `excluded` by reason, with `auto-abandoned` named specifically).

Measured before/after on this agent's live queue, 30-day window, rule change only:
**784 events → 18.** Considered 1,288; excluded 743 `not-completed:pending`, 494 `auto-abandoned`,
29 `not-completed:cancelled`, 2 `not-completed:in_progress`.

## Decision-point inventory

- `GET /metrics/learning-velocity` — a READ-ONLY observability route. It gates nothing, blocks
  nothing, and no code path branches on its output. The change alters what it REPORTS, never what
  anything DOES.
- `computeLearningVelocity` (`src/core/LearningVelocityScorer.ts`) — **untouched.** It remains a
  pure function over an event list; only the route's event GATHERING changed. Its 6 unit tests pass
  unmodified, which is the evidence that the scorer's contract is unchanged.
- No gate, hook, reaper, sentinel, scheduler, migration or config surface is touched.

## 1. Over-block

Not applicable — nothing here blocks. The adjacent risk is over-EXCLUSION: an action that genuinely
represents learning but is not marked `completed` no longer counts. That is the intended semantics
(the whole finding is that filing ≠ learning), and it is not silent: every exclusion is itemised by
reason in the response, so a reader can see exactly what was set aside and disagree with the rule if
they wish.

Two exclusions were chosen deliberately and could be argued:

- **`completed` with no `completedAt`/`updatedAt` → excluded, not back-dated to `createdAt`.**
  Back-dating would re-import the entire filing bias through the one remaining gap. On the live
  queue this bucket is EMPTY (all 20 completions carry `completedAt`), so the strict choice costs
  nothing today and closes the door for later.
- **`cancelled` for a considered reason → still excluded.** A deliberate cancellation may well
  embody a lesson, but it is not a completion, and admitting it would reopen the "closing a row
  counts as learning" path that produced the inversion.

## 2. Under-block

The score can now READ LOWER than reality if completions are recorded without status/timestamp
hygiene. That is a reporting risk, not a safety one, and it is bounded by the accounting block: a
low score with `counted: 1, excluded: {not-completed:pending: 743}` is legible as "almost nothing
has finished", which is the true statement. The previous behaviour had the opposite failure — a high
score that was structurally unfalsifiable — and an honest low number is strictly better than a
flattering unfalsifiable one.

`byType.learning` (registered learnings) and `byType.correction` (the correction ledger) are
unchanged: both are genuine learning artifacts rather than filings, so neither was touched.

## 3. Blast radius

One route handler in `src/server/routes.ts`. Consumers checked:

- `grep -rn "learning-velocity"` across `src/`, `scripts/`, `tests/` — the route is read by the
  CLAUDE.md template docs and the dashboard's plain-language surface; no code branches on
  `adaptabilityScore` or `byType.evolution`.
- The response is ADDITIVE (`counting`, `evolutionActions`); no existing field was renamed or
  removed, so a consumer reading `totalEvents`/`byType`/`adaptabilityScore` still parses.
- `tests/unit/LearningVelocityScorer.test.ts` — 6 tests, unmodified, pass. The scorer is untouched.

## 4. Rollback plan

Single-commit revert. No state, no config key, no migration, no persisted artifact; the metric is
recomputed from disk on every request. Reverting restores the old counting immediately.

## 5. Test coverage (all three tiers)

- **Unit** — `LearningVelocityScorer.test.ts` unchanged and passing (proves the pure scorer's
  contract did not move).
- **Integration** — `tests/integration/learning-velocity-routes.test.ts`, 7 tests. Three existing
  cases UPDATED (see §6) and three added: the real queue in miniature (5 filed-or-abandoned + 1
  completion → exactly 1 event, `auto-abandoned` counted as 2 and named); a `completed` action with
  no timestamp excluded rather than back-dated; and a completion outside the window excluded by
  DATE while still appearing in `counted`, so "counts completions" cannot become "counts every
  completion ever".
- **E2E** — `tests/e2e/learning-velocity-lifecycle.test.ts`: the `counting` rule and the
  `evolutionActions` accounting must survive the PRODUCTION initialization path, because the live
  endpoint is where a reader actually reads the number.

## 6. Three existing tests were encoding the defect

`learning-velocity-routes.test.ts` used action fixtures carrying only `createdAt` and asserted they
counted as learning events. Those assertions were a specification of the inversion: they would have
failed any correct implementation. Rewritten to use completions, with the filed-but-unfinished case
retained and asserted as an EXCLUSION rather than deleted.

This is the **third** time in one day a passing test was found protecting the defect beside it (the
others: the standards parser's five-family allowlist, and a fixture whose meaning changed with the
wall clock). Recorded rather than tidied away, because three instances in a day is a pattern about
how our tests get written — they pin current behaviour, and current behaviour is what the audit
found wanting. The class is worth a standard; it is not fixed here.
