# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

The dashboard Subscriptions tab now uses the full operational canvas instead of
the Process Health reading-column width. Its deprecated Pending logins mirror
is removed; completed and expired sign-ins report directly in their owning
account-machine cell.

## What to Tell Your User

Subscriptions is easier to use on both wide monitors and phones. The
account-by-machine grid has room to breathe, and sign-in progress and outcomes
now stay in the cell where the sign-in was started instead of being duplicated
in a separate panel.

## Summary of New Capabilities

- Fluid desktop layout with mobile-safe matrix scrolling.
- In-cell “Done” and “Didn’t finish” sign-in outcomes.
- One canonical sign-in surface instead of a duplicate Pending logins panel.

## Evidence

- `tests/unit/subscriptions-render.test.ts`
- `tests/unit/dashboard-panel-placement.test.ts`
- `tests/integration/subscriptions-tab.test.ts`
