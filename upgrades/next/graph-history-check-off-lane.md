# Saves are not held up by the history check after a restart

<!-- bump: patch -->

## What Changed

After a restart, the shared conversation history re-reads every saved record once to confirm it is intact. On a large history this took minutes, and it ran inside the one-at-a-time step that every save also goes through, so saves waited behind it until the Conversations page gave up ("your agent is not answering right now"). The check now runs on its own in the background, one at a time, and saves no longer wait for it. A check that takes more than 2 seconds is named in the log with its duration.

## What to Tell Your User

- **Accept all right after a restart**: "Accepting suggested projects no longer stalls for minutes after your agent restarts; the history check that caused it now runs in the background."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Saves answer in time right after a restart | Automatic |

## Evidence

Accept all round 4 part 3 (topic 144007): live run 2026-11-19 01:25-01:41Z on 1.3.1903-local.10c04fb looped on "Stopped at 2 of 14"; Studio log: "the owner step spent 450.1 s on the local history check". Test: `tests/integration/graph-default-boot.test.ts` (history check held open: upkeep returns, a save resolves, one check at a time).
