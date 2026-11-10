<!-- bump: patch -->
## What Changed

Registers the replicated kind that will carry the Context Budget's small layers between an agent's machines (`context-layer-record`, store `contextLayers`, `src/monitoring/contextLayerKind.ts`): per-entry anchor, ledger, chunk, summary and fold records with byte caps derived from the journal constants (refused, never truncated, for content; fold state is never size-refused), unique keys per entry, and finite retention. The fold coordinator's skew rule now reads it: a build without the kind refuses a fold (`layers-not-replicated`). Nothing emits to the kind yet.

## What to Tell Your User

Nothing changes for you yet. This is the channel that will keep a conversation's tidied-up memory the same on every machine I run on.

## Summary of New Capabilities

- Replicated `context-layer-record` journal kind (inert) and the fold skew rule wired to it.

## Evidence

- Unit `tests/unit/context-layer-kind.test.ts`; integration `tests/integration/context-layer-replication.test.ts` (real cross-machine apply); e2e `tests/e2e/context-layer-kind-alive.test.ts`.
