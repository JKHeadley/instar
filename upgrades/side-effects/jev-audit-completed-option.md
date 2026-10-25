# Side-Effects Review — Jev job audit: a success option in the run description

**Version / slug:** `jev-audit-completed-option`
**Date:** `2026-09-26`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; wording change to an observe-only research battery, off outside its soak window)`

## Summary of the change

`AUDIT_QUESTIONS.failure_class` listed only failure shapes (`did-nothing`,
`partial`, `wrong-target`, `errored-but-exit-0`, `cannot-tell`), which forced
every healthy run into one. On the live trial, health checks that correctly
reported a degraded server were labelled `errored-but-exit-0` (273 of 431 rows
on 2026-09-26). Adds a `completed` option and a clarifying sentence on
`false_success` that a check job which reports problems has done its work.

## Decision-point inventory

- *(none)* — the audit decides nothing; this changes the wording of questions
  whose answers are logged.

---

## 1. Over-block

Nothing is blocked. The risk is the reverse: a genuinely broken check job that
still prints some report could now read as `completed`. `false_success` and
`produced_declared_effect` still carry that judgement, and the soak report
compares against the deterministic column.

## 2. Under-block

The clarifying sentence covers check-and-report jobs only. Other job shapes
may have similar wording gaps; the operator's rule (suspect our context or
question before blaming the model) is now the first step for every confident
disagreement.

## 3. Level-of-abstraction fit

The battery is the frozen contract ("one code change per wording change"), so
the fix belongs exactly there.

## 4. Signal vs authority compliance

Signal-only per `docs/signal-vs-authority.md`: answers are logged, never acted
on.

## 5. Interactions

Rows written before and after the change measure different questions. The
trial clock is restarted after install so the soak report never mixes them.
No reader hard-codes the class list (checked: only this module names them).

## 6. External surfaces

None beyond the existing TypeSafe call, whose request body gains one choice
option and one sentence.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, as the audit already is: each machine audits its own
job runs into its own log.

## 8. Rollback cost

Revert the PR. Rows remain valid JSONL; `completed` is simply one more value
readers may see.
