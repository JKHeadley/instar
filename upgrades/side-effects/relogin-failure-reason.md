# Side-Effects Review — sign-in repair records failure reasons + detects the macOS Automation refusal

**Version / slug:** `relogin-failure-reason`
**Date:** 2026-09-24
**Author:** Echo

## Summary of the change

Store: additive `repair_events.reason` column (PRAGMA-guarded ALTER on open), `transition({reason})`, `reloginReasonToken()` allow-list (only code error-name prefixes; else `unclassified`), new failure class `automation-permission`. Orchestrator: transient/operator-only results may carry `reason`; retry/fail/operator-only transitions record it; the budget-exhausted event keeps the last reason. Driver: the catch path passes the error name as `reason`; `plain-browser-automation-not-permitted` → `operator-only` / `automation-permission`. Normal-browser transport: Apple Event error -1743 → that error, surfaced immediately from the launch wait. Operator notice text for that failure class names the setting.

## Decision-point inventory

- Classify a thrown drive error as transient vs operator-only — `invariant`: exactly one error name (from our own transport, raised only on errAEEventNotPermitted) maps to operator-only; everything else keeps today's transient behavior.

Additionally: the normal-browser launch waits for the target page's protocol (not about:blank), and the drive loop waits a bounded 15×1 s through an `origin: "null"` (about:blank) page before applying the origin floor. The floor itself is unchanged; a page that stays blank still refuses.

## 1. Over-block

A -1743 caused by something other than a missing permission would pause for the operator instead of retrying — acceptable: -1743 is specifically "not permitted", and the operator path is one tap ("Try repair again").

## 2. Under-block

The blank-page wait never acts on the page (wait only), so it cannot be abused to act on a foreign origin; it only delays the origin verdict by at most 15 s.


A permission prompt that is PENDING (not yet answered) shows as a timeout (-1712), still classified transient; three retries then fail with that reason recorded, which is now visible. Not treated as operator-only because a timeout has other causes.

## 3. Level-of-abstraction fit

Reason recording sits in the store/orchestrator (single place every transition goes through); classification sits in the driver (which already maps errors to outcomes); the error name originates in the transport that sees the Apple Event code.

## 4. Signal vs authority compliance

The reason column is a signal only; nothing reads it to decide. The one new decision (operator-only on a named permission refusal) reduces automated action — it never adds any.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added.

## 5. Interactions

`READMIT_BLOCKING_FAILURES` is unchanged — `automation-permission` is not a security class, so an operator retry re-admits normally. Existing exact-equality test on a deadline result updated to include the reason. Event row caps/pruning unchanged (one small nullable column).

## 6. External surfaces

`GET /subscription-relogin/:id/events` rows gain `reason` (additive field). Operator Attention notice text differs only for the new failure class.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The notice names the exact macOS location and the dashboard action; no jargon beyond the System Settings path.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: repair episodes and their events live on the machine that owns the login (`machine-local-justification: physical-credential-locality`). The events route is already readable from peers with the Bearer token, which is exactly what makes remote diagnosis possible.

## 8. Rollback cost

Revert. The extra column is harmless to older code (INSERT names its columns; SELECT * just returns one more field).

## Conclusion

Small observability + classification change inside the existing bounded repair. Safe to ship.

## Evidence pointers

`upgrades/next/relogin-failure-reason.md`; the four test files named there.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no new self-triggered action; one error now stops retries earlier"}`
