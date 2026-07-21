# Side-Effects Review — Decision-quality grading operationalization

**Version / slug:** `decision-quality-grading`
**Date:** `2026-07-21`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `decision_quality_review`

## Summary of the change

Extends the existing decision-quality census, rule registry, realcheck annotator, outcome chokepoint, run-end route, autonomous stop hook, and built-in grading job. It adds no second grading engine. The developer-process invariant refuses a malformed enrollment in CI; runtime grading remains observe-only.

## Decision-point inventory

- `provenance census enrollment` — modify — a wired point must have a registered grader or explicit measurement-only/exempt posture.
- `/autonomous/:topic/run-end` — pass-through — carries server-bounded realcheck evidence into the existing annotator; it does not decide whether a run may stop.
- `llm-decision-grading` cadence — modify — enables the existing bounded deterministic pass.

## 1. Over-block

The only new block is a developer-process ratchet. A legitimate new wired point would be blocked if its author omits both its real evidence rule and its explicit measurement-only/exempt posture. That is the intended malformed state. Runtime decisions and run shutdown are never blocked by grading.

## 2. Under-block

An explicitly measurement-only point remains ungraded by design, and a dishonest explanation can still pass the length floor. Review owns the semantic quality of that declaration. The runtime contradiction list catches structural drift, not fabricated evidence semantics.

## 3. Level-of-abstraction fit

The invariant lives beside `PROVENANCE_COVERAGE` and `RULE_REGISTRY`, the two sources whose contradiction it detects. Outcome evidence uses `AutonomousRealCheckAnnotator` and `annotateDecisionOutcome`; no parallel store, registry, adapter, or grading loop was added.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — runtime grading is an observe-only signal and has no block/allow surface.

The CI ratchet is a deterministic structural invariant over source declarations, not a semantic judgment about user or agent intent. The run-end annotation failure direction is named and non-blocking.

## 4b. Judgment-point check

No static heuristic was added at a competing-signals decision point. Pass/fail comes from the already-authoritative deterministic real check; this change only transports and records that outcome.

## 5. Interactions

- Shadowing: the annotation runs before terminal marking but catches every failure, so it cannot shadow run lifecycle.
- Double-fire: the run record persists the first accepted realcheck outcome per correlation id. Same-outcome replay is named duplicate; opposite replay is named conflict and cannot overwrite the grade. Evidence time derives from the persisted correlation timestamp, so identical replay is byte-stable.
- Races: before annotation, the route durably reserves the first outcome for the correlation. Reservation failure skips grading with `observation-persist-error` and cannot block terminal marking. A successful grade whose receipt-finalization write fails stays opposite-replay-safe via the reservation and is safely retried by same-outcome delivery.
- Feedback loops: grades are read-only observations and do not change model routing or gate decisions.

## 6. External surfaces

`GET /decision-quality` gains `censusDebt.wiredButNoGrader`; the run-end response gains `realcheckAnnotation`. The built-in grading job is enabled on fresh scaffold installs. No operator action, outbound message, URL, or external service is added.

The original converged meter spec required the cost-bearing Haiku wrapper to ship `enabled:false`. The newer operator goal-4 instruction explicitly requires enabling this scaffold under the Tier-1 lane. This artifact records that authority/posture change rather than claiming the older text already authorized it. Existing operator-edited installed jobs retain their current enabled state because the built-in-job migrator preserves explicit state; fresh scaffolds receive `enabled:true`.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design, proxied-on-read through the existing `GET /decision-quality?scope=pool` composition. Decisions and their realcheck evidence are written on the machine that ran the autonomous session. The job is `perMachineIndependent`; it emits no user-facing notice, creates no topic-keyed durable state of its own, and generates no URLs.

## 8. Rollback cost

Revert and ship a patch. The schema is unchanged. Existing grade rows remain valid and idempotent; disabling the scaffold job stops future cadence without state repair. The stop-hook migration replaces only stock-recognized copies and preserves customized hooks.

## Conclusion

The change closes the operational gap while preserving the existing authority boundaries and data model. Phase B owns reviewed rules and owners for the four explicitly measurement-only points: messaging tone, correction class review, completion claim verification, and feedback readiness. <!-- tracked: goal-4-phase-b -->

## Second-pass review

**Reviewer:** `decision_quality_review`
**Independent read of the artifact:** concur

Concur with the review. The reservation-first state machine preserves terminal lifecycle under write failure, blocks conflicting replay, permits safe same-outcome retry, and keeps grading observe-only. The review’s final non-blocking hardening note was also applied: only a `met:true` observation may reserve an outcome.

## Evidence pointers

- `tests/unit/provenance-coverage-ratchet.test.ts`
- `tests/unit/autonomous-stop-hook-realcheck.test.ts`
- `tests/e2e/decision-quality-alive.test.ts`

## Class-Closure Declaration (display-only mirror)

This change enables an existing self-triggered hourly job. `defectClass: unbounded-self-action`; `closure: guard`; `guardEvidence`: the hourly cron is one trigger per period and `runDecisionGradingPass` is bounded by the configured per-pass maximum, uses durable cursors, and is idempotent. The existing job-template ratchet pins the cadence and endpoint-only body; the controller performs no recursive dispatch, retry loop, notification, or LLM call. The general forcing guard is `tests/unit/self-action-convergence.test.ts`; no new autonomous emitter was introduced for registry enrollment.
