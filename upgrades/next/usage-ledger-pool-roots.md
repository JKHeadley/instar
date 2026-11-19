# Usage totals include local subscription account folders

<!-- bump: patch -->

## What Changed

The usage ledger checks local Claude and Codex account folders for this agent's recent work. An account added while the agent is running is picked up at the next scan. The scan uses the same membership rules for each folder. Historical copies count once when the original is available.

## What to Tell Your User

If recent work from a separate account was missing, the usage total can rise as the agent scans that account’s folder. A job with only a matching project directory still has no account attribution. The provider’s quota percentage comes from a separate reading.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Check which machine and folders contributed to the scan | Open the existing usage coverage report. Each folder lists whether it was examined and how many files are waiting. |
| Recognize incomplete discovery | If the local subscription registry cannot be read, the report identifies incomplete pool discovery. |

## Evidence

See tests/unit/UsageLedger.poolRoots.test.ts, tests/integration/usage-ledger-pool-roots.test.ts, and tests/e2e/unified-usage-ledger-alive.test.ts.
