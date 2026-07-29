# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The cost-state tracker now treats SDK-credit snapshots with a non-positive or
non-finite total as unknown. A zero remaining balance with a valid positive
total remains measurable as fully consumed.

## What to Tell Your User

An invalid zero-total credit pot no longer looks like a known, zero-percent
consumed budget.

## Summary of New Capabilities

- Validated SDK-credit denominator at the tracker boundary.
- Consistent unknown-state behavior with the existing HTTP comparison route.

## Evidence

- Fifty focused cost-state and routing-cache tests pass.
- Restoring the zero-total snapshot object makes the boundary test fail.
