# Side-Effects Review — Autonomous Operation: Stop Reason Is the Work + Constitutional Traceability (Stage 1)

**Version / slug:** `autonomous-operation-judgment-and-approval-as-data`
**Date:** `2026-06-01`
**Author:** `echo`
**Second-pass reviewer:** `independent lessons-aware convergence review (2 passes → converged)`
**Spec:** `docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md` (approved: true)

## Summary of the change

Stage 1 of the autonomy-governance spec. Ships TWO constitutional standards + their
real enforcement; Approval-as-Data (Part B / ApprovalLedger) is Phase 2 and is NOT
in this change.

1. **P13 "The Stop Reason Is the Work"** (constitution: `STANDARDS-REGISTRY.md`
   Substrate article + `INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` P13). An autonomous
   stop for "I need a judgment call" or "this needs real engineering" is a work item,
   not an endpoint. PRIMARY enforcement: `CompletionEvaluator.evaluateStopRationale`
   (a fail-open LLM guard) exposed at `POST /autonomous/evaluate-stop` and consulted
   by `autonomous-stop-hook.sh` at both stop-approve points before permitting a stop.
   SECONDARY backstop: `B18_AUTONOMY_STOP` in `MessagingToneGate` (sibling to
   B15/B16/B17, precedence `B15 > B16 > B17 > B18`).
2. **Constitutional Traceability "No Unconstitutional Work"** (constitution:
   `STANDARDS-REGISTRY.md` Building article). Every spec must trace to a constitutional
   standard with an indisputable fit. Commit-time STRUCTURAL gate (`instar-dev-precommit.js`
   Step 7.6): a staged spec's `parent-principle` must resolve to a real registry
   article. Review-time QUALITATIVE gate: `StandardsConformanceReviewer.judgeFit` →
   `fit`/`weak`/`none`, returned by `POST /spec/conformance-check` as `report.fit`.

Behavior is **build+test only**: nothing is activated in production; no session-pool
stage, lease, or config is flipped.

## Decision-point inventory

- `evaluateStopRationale` STOP_OK vs STOP_BLOCKED (LLM judgment; fail-OPEN to allow on
  error/ambiguity — a secondary guard must never trap a genuine completion).
- `judgeFit` fit/weak/none (structural parent-resolution → `none` block; LLM qualitative
  → fit/weak/none; fail-OPEN to `fit` when degraded).
- B18 block/pass (LLM; favors false-negatives).

## 1. Over-block risk
The completion evaluator could trap a legitimately-finished run; B18 could hold a
genuine completion message. Both favor false-negatives (permit when uncertain). The
evaluator only re-injects when the stop *classifies* as judgment/engineering AND no
artifact/derived-standard/operator-residual is shown. Tested: STOP_OK/empty/error →
stopAllowed:true.

## 2. Under-block risk
A silent stop emitting no message evades B18 — which is exactly why the PRIMARY surface
is the completion evaluator (the stop-hook), not the message gate. The conformance gate
could pass a hand-wave parent — mitigated by judging fit with a full-context reviewer,
not a string match.

## 3. Level-of-abstraction fit
Enforcement sits at the stop decision (the structural Stop-hook event) and the commit
boundary (pre-commit), not buried in prompt prose — the strongest available surfaces.

## 4. Signal vs Authority
Arithmetic/structural checks (parent-resolution string match) are signals/preconditions;
the LLM conformance reviewer is the authority for the qualitative fit. No brittle
deterministic check acquires blocking authority over the *qualitative* judgment.

## 5. External surfaces
Adds `POST /autonomous/evaluate-stop` (thin wrapper over the evaluator; 503 when absent)
and a `fit` field on `POST /spec/conformance-check`. No new outbound external calls.
Both routes classified INTERNAL/build-time.

## 6. Interactions with existing primitives
B18 de-conflicted from B15 via citation precedence `B15 > B16 > B17 > B18`. The
completion-evaluator P13 guard EXTENDS (does not replace) the existing
`/autonomous/evaluate-completion` flow — it only adds a check before an *approve*. The
conformance fit composes with the existing trace/approved/eli16 ship-gate checks.
`judgeFit` reuses the existing reviewer + registry parser. The new Constitutional
Traceability article was placed in the **Building** family (the registry parser
`STANDARDS_FAMILY_RE` only recognizes Root/Substrate/Building/Shipping/Interaction — a
Fractal placement would not have parsed; caught by unit test).

## 7. Rollback cost
All additive + default-safe. B18 disable = remove from `VALID_RULES` (fail-open). The
stop-hook P13 guard fails-open (server down / 503 / missing field → permit). The
conformance fit fails-open to `fit` when degraded. Step 7.6 fails-open if the registry
is unreadable. No production state is changed by this commit.

## Migration parity
- P13 + Constitutional Traceability registry/principles text reach existing agents via
  the normal dist update (pure docs); the conformance gate + completion evaluator are
  shipped code.
- The `autonomous-stop-hook.sh` change reaches existing agents via
  `PostUpdateMigrator` (`upgrade()` marker bumped to `p13_stop_allowed`,
  customization-safe, idempotent).

## Tests
105 green across 3 tiers: unit (`CompletionEvaluator`, `standards-conformance-gate`,
`messaging-tone-gate-b18`), integration (`standards-conformance-gate` fit,
`autonomous-evaluate-stop`), e2e (`standards-conformance-gate-lifecycle` fit-alive).
`tsc --noEmit` clean. B15/B16/MessagingToneGate regression-green. Test-writing caught
two real bugs (the Fractal-family parse exclusion above; the B18 response-format
enumeration omission at MessagingToneGate response-format line).
