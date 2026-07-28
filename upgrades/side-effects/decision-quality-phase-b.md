# Side-Effects Review — Decision-quality Phase B backlog grading

**Version / slug:** `decision-quality-phase-b`  
**Date:** `2026-07-21`  
**Author:** `Instar Agent (instar-codey)`  
**Second-pass reviewer:** `not required`

## Summary of the change

This extends the existing decision-quality rule registry and deterministic grade pass for `messaging-tone-gate`, `correction-class-review`, `completion-claim-verify`, and `feedback-readiness`. It removes their measurement-only declarations, registers four immutable window-close rules, shares the existing bounded budget across five job-owned points, and records mature evidence-absent rows as `unknown` through the existing annotation chokepoint and ledger.

## Decision-point inventory

- `messaging-tone-gate` — modified — gains a job-owned window-close unknown rule.
- `correction-class-review` — modified — gains a job-owned window-close unknown rule.
- `completion-claim-verify` — modified — gains a job-owned window-close unknown rule.
- `feedback-readiness` — modified — gains a job-owned window-close unknown rule.

## 1. Over-block

No block/allow surface — over-block not applicable. Grading cannot change or suppress any originating decision.

## 2. Under-block

No block/allow surface — under-block not applicable. The grading limitation is explicit: absent independent evidence becomes `unknown`, so this change does not claim to distinguish correct from incorrect historical decisions.

## 3. Level-of-abstraction fit

The change lives in the existing evidence-rule registry, grading pass, annotation chokepoint, and feature-metrics ledger. It adds no parallel store, scheduler, route, or metric table. Window age is mechanical evidence processing, not a competing semantic authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It records an observation about evidence availability after a bounded window. It has no authority over messages, actions, task selection, model routing, or the four originating judgments.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The only new predicate is the enumerable invariant “registered evidence window closed with no winning outcome,” whose honest result is `unknown`.

## 5. Interactions

- **Shadowing:** existing right/wrong outcomes are checked first and advance the cursor; they are never replaced by the unknown terminalizer.
- **Double-fire:** outcome writes use the existing correlation-id × grader upsert and therefore converge on replay.
- **Races:** each point retains its durable keyset cursor and P19 backoff. Concurrent route/job calls converge through the same ledger.
- **Feedback loops:** grades remain read-only observations and authorize no downstream action.

## 6. External surfaces

`GET /decision-quality` changes visibly: mature rows move from `expired` to `unknown` and increase `outcomesKnown`. `POST /decision-quality/grade-pass` can report the four new rule ids in `byRule`. There are no user notices, external service calls, new operator actions, or raw-content fields.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Proxied-on-read.** Decision rows, outcomes, and cursors remain machine-local because they describe decisions made on that machine; the existing `GET /decision-quality?scope=pool` field-allowlisted merge supplies the pool view. The change emits no notices, holds no topic-bound state, and generates no URLs.

## 8. Rollback cost

Revert and ship a patch. Existing unknown outcome rows are valid under the pre-change schema and remain truthful if retained; no migration or agent-state repair is required. Re-running after rollback does not multiply rows.

## Conclusion

The design stays inside the existing observe-only quality substrate and deliberately refuses to infer success or failure from missing evidence. Focused tests cover window bounds, fair cursors, idempotency, and the authenticated count transition. Clear to ship.

## Second-pass review

Not required: this changes observe-only accounting and no gate, sentinel, outbound flow, session lifecycle, or blocking authority.

## Evidence pointers

- `tests/unit/decision-grading-pass.test.ts`
- `tests/integration/decision-quality-routes.test.ts`
- `tests/unit/provenance-coverage-ratchet.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
