# Side-Effects Review — CommitmentTracker.verify() batches store saves (event-loop wedge fix)

**Version / slug:** `commitment-tracker-verify-batches-saves`
**Date:** `2026-06-21`
**Author:** Echo (autonomous)
**Second-pass reviewer:** required (touches a core monitoring write path on every agent)

## Summary of the change

`CommitmentTracker.verify()` runs on a 60-second timer. It iterates every *active*
commitment and mutates each via `mutateSync()`, and **every** `mutateSync()` calls
`saveStore()`, which does `JSON.stringify(this.store, null, 2)` of the **entire**
commitments store. With a large store (observed live on Echo: **1.6MB, 1,724
commitments**, 1,137 of them terminal/never-pruned) and N active commitments, that is
**O(N) full-store serializations per sweep** — hundreds of 1.6MB pretty-printed
serializations every 60s. This monopolized the single event-loop thread for **minutes**:
`/health` returned HTTP 000, and an external watchdog SIGKILL/respawn loop ensued
(diagnosed 2026-06-21 via a `JSON.stringify` entry-tracer that caught the
`verify → verifyOne → mutateSync → saveStore` stack firing repeatedly in one sweep).

The fix:
1. **Batch the sweep's writes.** `verify()` sets a `batchingSaves` flag for the duration
   of its (fully synchronous) sweep; while set, `saveStore()` marks the store dirty and
   returns instead of writing. The sweep flushes **exactly one** write at the end. This
   collapses O(N) serializations to 1 per sweep. Proven by a new unit test: 40 mutated
   commitments → 1 store write (was 40).
2. **Compact JSON.** `JSON.stringify(this.store)` (drop `, null, 2`) — the store is a
   machine-read state file; pretty-printing ~1.6MB was pure serialization + I/O overhead.

## Decision-point inventory

- **Batch scope = the verify() sweep only.** A lone `mutateSync()` outside `verify()`
  (e.g. from PresenceProxy / PromiseBeacon / a route) still persists immediately —
  batching is sweep-scoped, asserted by a second unit test. Chosen because `verify()` is
  the only O(N) caller; broadening batching would risk a non-sweep mutation not landing.
- **Safety of deferral.** `verify()` is fully synchronous (no `await` between mutations;
  `verifyConfigChange`/`verifyBehavioral` use `readFileSync`), so the event loop never
  turns during the deferred window → no concurrent write path can observe or interleave.
  A crash mid-sweep loses only the in-memory mutations of that sweep, which the next
  idempotent sweep re-derives — strictly no worse than the prior per-mutation writes.
- **Compact vs pretty.** Compact chosen; `loadStore()` parses with `JSON.parse` (format
  agnostic), and the replication peer reader parses the same way. No human/tool consumes
  the file as formatted text.
- **NOT in scope (tracked follow-up):** pruning terminal commitments to bound store
  growth. The batch+compact fix removes the wedge regardless of store size; pruning
  interacts with the P1.5 replication incarnation/seq machinery and deserves its own
  reviewed change.

## Roll-up across the seven review dimensions

- **Security:** none — no new inputs, no auth/credential surface, no external I/O change.
- **Scalability:** the entire point — per-sweep cost goes from O(N × storeSize) to
  O(storeSize). Removes a fleet-wide event-loop-freeze class as commitment stores grow.
- **Adversarial:** the deferred-save flag is process-local and reset in a `finally`; a
  thrown error inside the sweep still flushes and clears the flag.
- **Integration:** `saveStore()` and `verify()` are internal; the only behavioral change
  is *fewer* identical writes. The store's on-disk shape is unchanged (still the same
  JSON object, just compact).
- **Reliability:** one atomic write per sweep instead of N — fewer fsync/rename cycles,
  less chance of a partial-write window.
- **Observability:** unchanged (the `verification` event still emits post-flush).
- **Migration parity:** pure code path; no installed-file/config/CLAUDE.md change, so no
  PostUpdateMigrator entry needed. Existing agents get it via the normal dist update.

## Evidence pointers

- New test: `tests/unit/CommitmentTracker-verify-batches-saves.test.ts` (2 cases) — green.
  Asserts 1 store write per sweep over 40 mutated commitments, and immediate persist for a
  lone mutate.
- Live diagnosis: a `JSON.stringify` tracer on Echo's server captured the
  `CommitmentTracker.saveStore` stack firing repeatedly from `verify()`'s timer; the store
  was 1.6MB / 1,724 commitments. Post-hotfix the per-sweep write count dropped to 1 and the
  4+ minute freezes shortened.
