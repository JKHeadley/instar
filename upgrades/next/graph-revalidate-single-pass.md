# Conversation graph revalidation verifies records once, not three times

<!-- bump: patch -->

## What Changed

`GraphSourceObservationRecoveryCoordinator` (the source-observation revalidation run by `validatedContinuation`, once per record continued during Accept all) verified the whole source collection three times per call, synchronously: every row to find pending rows, every row again inside `certifiedUnion`, and every union row a third time. At ~550 rows that held the event loop for 2-5 s per call. It now tests the cheap terminal flags before verifying (only pending rows are verified), and skips re-verifying rows `certifiedUnion` just verified against their own writer in the same synchronous step (new read-only `verifiedEventIds` on the union result; rows the union rebuilds are excluded). The checkpoint branch indexes union rows by source id and by newest producer sequence instead of scanning every row per entry (quadratic before). Verdicts are unchanged.

## What to Tell Your User

- **The agent stays responsive during Accept all**: "When you accept several suggested projects at once, I no longer freeze for seconds at a time while I double-check my records, so pages and replies keep coming."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Faster conversation-graph revalidation (one verification pass instead of three) | Automatic |

## Evidence

CPU profile of the two-machine accept-all rig during a real Accept all (6 × 75 s, 2026-11-18 00:46-00:55Z): revalidation 34% of busy time, uninterrupted stretches up to 5.5 s. After-fix measurement on the same rig is in the PR body. Unit test: `tests/unit/conversation-graph-replication.test.ts` ("names only rows it verified against their own writer and returned unchanged as verifiedEventIds").
