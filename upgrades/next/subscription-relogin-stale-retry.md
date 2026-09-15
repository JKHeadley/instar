# Subscription dashboard stale-retry correction

## What Changed

The Subscriptions dashboard now lets current account health outrank durable repair history. If a previously failed or suggested repair remains in the audit ledger after the account is already Active, the grid and account card no longer show that old episode as actionable or offer a retry the server must refuse.

The click path also self-heals if account health changes between rendering and tapping: the dashboard refreshes current state instead of exposing the internal revalidation error. Point-of-use revalidation refusals are returned as conflicts rather than server errors.

## What to Tell Your User

If an account is already Active, an old failed repair will disappear automatically after the next dashboard refresh instead of asking for another retry.

## Summary of New Capabilities

- Current Active subscription health supersedes stale suggested and failed repair actions.
- An already-active click race refreshes the dashboard without exposing internal error codes.
