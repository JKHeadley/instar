# Side-Effects Review — provider colors on the Subscriptions dashboard

**Version / slug:** `subscriptions-provider-colors`
**Date:** 2026-09-25
**Author:** Echo

## Summary of the change

`dashboard/subscriptions.js`: new exported `providerClass()` (closed mapping). The provider group entries carry `__providerKey`. Headings, cards, grid band cells and grid rows add the provider class. `dashboard/index.html`: CSS for the three classes (tinted band, colored left edges). There are no data, route or state changes.

## Decision-point inventory

None. This is presentation only.

## 1. Over-block
None.

## 2. Under-block
None. Providers other than Claude and Codex fall back to a neutral grey.

## 3. Level-of-abstraction fit
Styling lives in the dashboard CSS, and the class choice sits beside the existing grouping helper.

## 4. Signal vs authority compliance
Not applicable. No decision logic.

## 5. Interactions
`groupAccountsByProvider`'s order and single-provider rules are untouched (their tests still pass). Existing classes stay in place, so the existing selectors still match.

## 6. External surfaces
The dashboard's look only. A provider string cannot reach a class name raw; `providerClass` is a closed mapping, and a test covers a hostile string.

## 7. Multi-machine posture
Unchanged. It renders the same pool-scope data.

## 8. Rollback cost
Revert the PR.

## Conclusion
Presentation-only and safe to ship.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "presentation-only dashboard styling"}`
