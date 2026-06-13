# Upgrade Guide — Live credential re-pointing (Increment A, Step 6b)

<!-- bump: patch -->

## What Changed

Step 6b — the resolver registry + the first three census re-routes (the QuotaPoller's location reads), shipping **dark**. The registry lets the ~12 consumers reach the location resolver without threading it through a dozen constructors, and it defaults to a no-op so every re-route is provably today's behavior until the feature is wired and enabled. The QuotaPoller now (when the feature is live) reads and refreshes each account's token in its CURRENT slot rather than its enrollment home, and stops auto-patching the pool email from the enrollment home while the ledger is the location authority (which after a move would record the wrong account's email). All no-ops while dark.

## What to Tell Your User

Nothing changes for you — internal wiring for the upcoming restartless rebalancing, shipping switched off. This step makes the quota poller (the background piece that reads how much of each subscription is used) location-aware, so once logins can move between slots it always reads the right account's usage and never refreshes or mislabels the wrong one. You won't see any difference until the feature is enabled.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Location-aware quota polling | Automatic (internal) — reads/refreshes each account's token in its current slot; no-op until enabled |
| Pool-email cross-contamination guard | Automatic (internal) — the enrollment-home email is not trusted into the pool while the ledger is authoritative |

## Evidence

- 4 new unit tests: the resolver registry (default no-op; wire-and-reset) + census #3 email-suppression both-sides (dark patches the email from the enrollment home; active suppresses it). The existing 13 QuotaPoller tests prove the dark path is byte-identical.
- `npx tsc --noEmit` clean; the credential-write lint clean.
