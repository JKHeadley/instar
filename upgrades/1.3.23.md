# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Framework-Onboarding Mentor System — fault-isolate the ledger from TokenLedger init.** Found by
deploying to a real server: the mentor issue-ledger and runner were constructed in the same
try-block as the TokenLedger, so an agent whose TokenLedger init throws (e.g. a stale token-ledger.db
schema — `no such column: attribution_key`) had its `/framework-issues` + `/mentor/*` routes return
503 purely as collateral. Moved the mentor ledger + runner to their own independent try/catch, so a
TokenLedger failure can no longer cascade. Tests use a fresh state dir where TokenLedger is healthy,
which is why this only showed up on a real deploy.

## What to Tell Your User

- The mentor system now stays available even on agents whose (unrelated) token-usage ledger is in a
  bad state — a real situation that was silently 503-ing the mentor routes.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fault-isolated mentor init | Automatic — `/mentor/*` + `/framework-issues` survive a TokenLedger init failure |

## Evidence

Found in production (not a test gap): deployed the merged mentor system to a real server whose
TokenLedger had been throwing `no such column: attribution_key` since 2026-05-25, and the mentor
routes all returned 503 as collateral. Fix proven by an e2e regression that pre-plants a corrupt
`token-ledger.db` (forcing the real TokenLedger constructor to fail) and asserts `/mentor/status` and
`/framework-issues` return 200, not 503 — the cascade is broken. 7 mentor e2e tests; affected
push-config suite green vs canonical main.
