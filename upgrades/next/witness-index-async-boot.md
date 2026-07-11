# Witness index boot safety

## What Changed

Large replicated journals no longer delay server boot. Witness-index construction and its parity pass begin only after the server is listening and yield between fixed-size journal chunks.

## What to Tell Your User

Agents with large replicated histories can start normally again. The optimization warms in the background while the existing correct witness lookup remains active.

## Summary of New Capabilities

- Zero journal reads in the peer-stream reader constructor.
- Post-listen cooperative index and parity rebuild.
- Generation fencing prevents a stale or half-built index from being published.
- Existing parity mismatch fallback remains intact.

## Evidence

The regression fixture builds a multi-megabyte replicated journal. Before this fix, construction synchronously read the journal twice; after this fix, construction performs zero journal reads and returns within the bounded threshold, while the post-listen rebuild produces the same witness answer.
