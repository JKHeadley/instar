# Conversations pages build one verified view per load, not one per project title

<!-- bump: patch -->

## What Changed

Each read of the conversation graph (roots, a node, destinations, unassigned conversations) now runs against one verified view built at its start (`ConversationGraphReplicationRuntime.withPinnedReadView`, via the read source's `scoped`). Before, while any write was in flight the view could not be cached, and each effort title on the page (`EffortHeaderStore.titleOf` → `retainedForRead`) rebuilt the whole view: `certifiedUnion` plus the source inventory, decrypting every payload. On the accept-all rig that held the event loop 20-28 s per page read during Accept all. The pin lasts only for the synchronous read call; writes are unchanged.

## What to Tell Your User

- **Conversations page stays responsive while saving**: "While I'm saving changes, like accepting several projects at once, the Conversations page no longer freezes me for long stretches."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One verified graph view per page read | Automatic |

## Evidence

Rig CPU profile during Accept all (2026-11-18 01:36Z): 27.9 s uninterrupted stretch, 87% in `readView` rebuilt from `effortTitle`. Tests: `tests/unit/conversation-graph-read.test.ts` (entry points run inside the scope; 24 passed) and a new case in `tests/integration/conversation-graph-read-view-cache.test.ts`.
