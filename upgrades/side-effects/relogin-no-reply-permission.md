# Side-Effects Review — a no-answer Chrome launch is handed to the operator

**Version / slug:** `relogin-no-reply-permission`
**Date:** 2026-09-25
**Author:** Echo

## Summary of the change

Driver classification: reason prefix `chrome-launch-timeout-apple-event-no-reply` joins `plain-browser-automation-not-permitted` as `operator-only` / `automation-permission`. Notice text adds the "click Allow on the prompt" path.

## Decision-point inventory

- Error → outcome classification — `invariant`: one more fixed token maps to operator-only (fewer automated retries).

## 1. Over-block

A Chrome that is hung for another reason for 30 s would also be handed to the operator instead of retried; the operator's "Try repair again" covers it.

## 2. Under-block

None new.

## 3. Level-of-abstraction fit

Same place as the existing permission classification.

## 4. Signal vs authority compliance

Reduces automated action only.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

`automation-permission` is not a security failure class, so no 24-hour breaker is triggered; the operator retry re-admits normally.

## 6. External surfaces

Operator notice wording.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Names the exact place and action.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource` — the permission is granted per macOS user on each machine.

## 8. Rollback cost

Revert.

## Conclusion

Tiny, safe. Ship.

## Evidence pointers

`upgrades/next/relogin-no-reply-permission.md`.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "reduces retries only"}`
