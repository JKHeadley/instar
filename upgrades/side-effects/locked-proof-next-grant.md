# Side-Effects Review — confirm the next grant in locked-Mac proof

Date: 2026-11-17
Author: Echo
Second-pass reviewer: review_proof_grant (concurred)

## Summary of the change

Tier 1: narrow, reversible test-harness correction. Two script files and one test file, plus ELI16 and release artifacts. One independent review round; one staging attempt denied by filesystem permissions, no commit/gate attempts yet. Case 12.10 previously announced next-grant-open even after its viewer wait timed out, and its verdict accepted missing or false opened evidence. Require visible controls before announcing the event and explicit opened:true in recorded evidence before passing.

## Decision-point inventory

Modify the proof verdict and next-grant setup success check. No product dispatch, process lifecycle authority, access policy, or production safety decision changes.

## 1. Over-block

A grant that opens after the existing 30-second setup timeout now fails the case instead of silently continuing. That is a failed setup, not evidence of the intended scenario. No user requests are blocked.

## 2. Under-block

Visible controls are the existing viewer signal for an opened grant. This does not prove every takeover safety invariant, nor does it replace actual proof-Mac execution. It specifically closes acceptance of absent or explicitly failed next-grant setup. No new production failure mode identified.

## 3. Level-of-abstraction fit

The real driver owns observation; the existing judge owns the proof verdict. Both use the existing fired-step record. No parallel product authority introduced.

## 4. Signal vs authority compliance

See docs/signal-vs-authority.md. This is structural verification of test evidence in a constrained scenario, not judgment about an agent or user's intent. No block/allow surface in the product.

## 5. Interactions

An opening error reaches runCase's existing catch/finally recovery; cont-old-guard is not attempted as a test injection when setup fails. Recovery still resumes stopped processes and locks the proof session. The independent verdict also rejects historical evidence lacking confirmed opening.

## 6. External surfaces

Only proof case results change. Failed setup becomes an explicit failure. No runtime API or native helper changes. The viewer may time out due to external conditions, which is correctly recorded rather than treated as a pass.

## 7. Multi-machine posture

Machine-local by design: the harness runs against the dedicated proof account. Committed harness changes reach each proof checkout through source control. No durable fleet state, notification, URL, or topic ownership changes.

## 8. Rollback cost

Revert the commit; no migration or agent state repair.

## Validation

Two negative regression tests failed before the fix. The recovery session reran the complete affected test file without the earlier sandbox restriction: all 78 tests passed, including the process-owner test. Full-suite verification is in progress before delivery. This is not a live-Mac proof claim.

## Independent review

Concur with the review. Reviewer review_proof_grant independently ran all four new regressions: four passed, no blocking findings. The reviewer confirmed driver failure propagation, independent verdict validation, and existing recovery execution. This is not live-Mac proof.
