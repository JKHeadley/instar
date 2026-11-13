# The decision-quality bucket recompute ranks only its own bucket's outcomes

<!-- bump: patch -->

## What Changed

`FeatureMetricsLedger.upsertOutcome()` recomputes one `(decision_point, day)` rollup bucket per outcome, in `recomputeQualityBucketInTx()` and `recomputeByModelBucketInTx()`. Both joined the `decision_winning_grade` view, whose window function ranks every row of `decision_outcomes` before the join can restrict it, so each recompute scanned the whole outcomes table.

Both now join `BUCKET_WINNING_GRADE_SQL`: the same ranking applied only to outcomes whose `correlation_id` belongs to a decision in the bucket. The ranking text is a shared constant, `WINNING_GRADE_RANK_SQL`, from which the view's DDL is also built, so precedence is still defined once.

No schema change. The view, the read routes and the reconcile are unchanged.

## What to Tell Your User

Nothing changes that you will see. The agent's own scorekeeping of its judgment calls no longer makes its server stop answering while a batch of grades is recorded.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Decision-quality rollup recompute scoped to its bucket | Automatic |

## Evidence

Studio, 2026-11-13 13:00:30Z, `logs/server-freeze/freeze-20261113T130030Z.txt`: three failed health checks, the server at 89.5% CPU; an 8-second JS profile shows 51.1% of self time in better-sqlite3 `get` and 48.3% in `run`, under `recomputeQualityBucketInTx` and `recomputeByModelBucketInTx` from `upsertOutcome`, from `annotateOutcome`, from `gradeOnePoint` in `runDecisionGradingPass`. Supervisor log: "Server process alive but unresponsive for 7 checks (~70s) — restarting". The `main` verify in flight was killed.

Measured read-only on the Studio's live database (412,698 decisions, 61,683 outcomes), six real buckets with 182 to 1,833 outcomes: the aggregate through the view took 97 to 106 ms; the scoped form took 1.0 to 4.5 ms and returned identical counts each time. The view's query plan contains `SCAN o`; the scoped one reaches outcomes by `SEARCH o USING INDEX`.

Tests: `tests/unit/FeatureMetricsLedger-scopedRecompute.test.ts` (7, new): both rollup tables equal the view-derived reference over random decisions, graders, rungs, grades, regrades and day-edge timestamps (three seeds); the strongest rung wins; the plan uses the index (with a control showing the view scans); view and recompute share the precedence text; the recompute no longer joins the view. Three faults were introduced and caught: the bucket edge one hour short, one millisecond short, and the precedence order flipped. Existing ledger, recorder and grading-pass tests unchanged and passing (96 across five files).
