<!-- bump: patch -->
## What Changed

Adds the per-topic fold lock the Context Budget work will use (`src/core/KeyedLease.ts`, `src/core/foldLeaseFactory.ts`, keyed signing in `FencedLease`): a signed, generation-fenced lock per topic with the topic inside the signature, on a local medium (one file per topic under `.instar/state/fold-leases/`) and a git medium (compare-and-swap by push), with a coordinator-to-sentinel handover that never re-acquires. The machine lease is untouched. Nothing uses the lock yet.

## What to Tell Your User

Nothing changes for you yet. This is the lock that will make sure only one part of me ever reorganizes a conversation's working memory at a time.

## Summary of New Capabilities

- A signed per-conversation lock (local and git media) for the coming conversation-folding work; not used yet.

## Evidence

- Unit `tests/unit/KeyedLease.test.ts`; integration over a real git remote `tests/integration/keyed-lease-git-medium.test.ts` (one CAS step measured at 157 ms on a local remote); e2e on real machine identities `tests/e2e/fold-lease-production-crypto.test.ts`.
