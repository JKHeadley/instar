<!-- bump: patch -->
## What Changed

The first piece of the Chief of Staff (docs/specs/chief-of-staff-topic.md): a new replicated-record kind, `chief-of-staff-record` (store key `chiefOfStaff`), and the pure store module behind it (`src/core/ChiefOfStaffStore.ts`). It carries the Chief of Staff's conversation tree, project bindings (goal, definition of done, cadence, linked repos), binding lifecycle events, check events, action intents with their transition log, operator check-in renewals, graduation records and loop liveness markers — every one an immutable event, with open/closed state, intent state, restart brakes and lease expiry derived by folding the union, so two machines can never disagree and arrival order cannot change a view. `CoherenceJournal` gains `emitReplicatedRecordWithSeq` and `awaitDurableSeq`, the wait the action protocol needs before any spawn. Retention for the kind is never-delete. Nothing emits yet: the kind is registered but dark on every agent.

## What to Tell Your User

Nothing yet. This change is invisible: it lays the storage the Chief of Staff conversation will use once it ships. No conversation, notice, setting or behaviour changes.

## Summary of New Capabilities

- Replicated store kind `chief-of-staff-record` with immutable event records and pure folds (bindings, lifecycle, intents/outcomes, check events, renewals, graduation, last-tick).
- `CoherenceJournal.emitReplicatedRecordWithSeq()` and `awaitDurableSeq()` so a caller can wait for a record to be fsynced before taking a side effect.

## Evidence

- `tests/unit/ChiefOfStaffStore.test.ts` (39): schema both-sides, legal transitions, folds, brakes, lease, convergence.
- `tests/unit/chief-of-staff-store-wiring.test.ts` (5): dual registry, allowlist, applier map, retention, darkness scan.
- `tests/integration/chief-of-staff-replication.test.ts` (6): real journal round-trip, op-key dedupe, seq + durability wait.
- `tests/e2e/chief-of-staff-store-lifecycle.test.ts`: production emitter → applier → peer read on a second machine, flag-off path emits nothing, concurrent-write convergence.
- Ratchets updated: `tests/unit/CoherenceJournal.test.ts` kind list; reconciler-wiring allowlist; envelope kinds coupling.
