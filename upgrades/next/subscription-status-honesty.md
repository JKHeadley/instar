# Throttle episodes and honest account status

## What Changed

Two user-facing honesty fixes. First, throttle notifications are now per-episode: one message when throttling engages, one when it clears, with a 15-minute post-close cooldown — instead of dozens of identical per-tick repeats. Second, the dashboard Subscriptions tab now derives each account's displayed status from its live credential state: an account whose stored login no longer matches its labeled identity (or that is awaiting an owner re-login) shows "needs re-login" instead of an "Active" carried over from enrollment.

## What to Tell Your User

You will no longer get a flood of identical throttle messages — one when it starts, one when it ends. And the Subscriptions tab now tells you honestly when an account needs a fresh sign-in, instead of showing every enrolled account as active.

## Summary of New Capabilities

- Per-episode throttle narration with typed suppressed outcomes and a race-safe auto-close timer.
- Effective account status on the Subscriptions grid and account header: identity drift or a pending owner re-login renders as needs-re-login, authoritative over enrollment status.

## Evidence

- Unit tests for episode dedup, cooldown, and the stale-timer guard.
- A render test proving a drifted account's grid cell shows the needs-re-login state.
- Full CI green on PR #1468.
