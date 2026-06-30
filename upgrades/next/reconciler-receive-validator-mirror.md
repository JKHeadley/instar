<!-- bump: patch -->

## What Changed

Completes root cause #3 of the cross-machine "stuck move" fix. The ownership
reconciler writes a cooperative-handoff record (`reason: 'reconcile'` + optional
`status`/`transferTo`/`timestamp`/`drainInFlight`) into the coherence journal when it
transfers a topic between machines. The journal has TWO hand-mirrored validators — emit
(`CoherenceJournal.validate`) and receive (`JournalSyncApplier.validateData`) — that
carry a "KEEP IN SYNC" comment. #1311 extended the emit side to accept the handoff shape
but never mirrored it into the receive side. So the RECEIVING machine rejected every
real transferring record, marked the peer's `topic-placement` stream `suspect`, and
HALTED cross-machine replication — the target never claimed, the move stayed stuck. This
mirrors the emit-side validation into the receive side (accept `reconcile` + the handoff
fields with the same strict per-field checks and `known`-keys allowlist), so a transfer
record replicates and the target claims. Surfaced by a live two-machine proof — the
single-process tests covered emit + applier-materialize but never the cross-machine
receive-validation step.

## What to Tell Your User

Nothing yet — the convergence loop remains off by default (dev-gated). This makes the
already-shipped #3 fix actually work end-to-end across machines (it never did before:
the receiving side rejected the hand-off). No change to normal use.

## Summary of New Capabilities

- (Dark) Cross-machine ownership transfers now replicate end-to-end: the receive-side
  journal validator accepts the cooperative-handoff record the reconciler emits, so the
  target machine claims the topic instead of the stream silently going `suspect`.

## Evidence

- Unit: `tests/unit/JournalSyncApplier.test.ts` — new describe block "Fix #3 — receive-side
  accepts cooperative-handoff (transferring) records": a real transferring record applies
  + stream stays `current` (FAILS before the fix — stream goes `suspect`); explicit
  `status:active` + `drainInFlight` accepted; a malformed handoff field still rejected →
  `suspect`; an unknown extra key still rejected. 30 tests pass; the 2 acceptance tests
  fail for the right reason with the fix reverted (verified).
- Related multi-machine suite green: JournalSyncApplier + CoherenceJournal +
  OwnershipReconciler + OwnershipApplier + CoherenceJournalReader + topic-pin-replication
  + pool-reconciler-route = 145 tests pass. `tsc --noEmit` clean.
