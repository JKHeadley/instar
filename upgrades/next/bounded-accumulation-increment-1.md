<!-- bump: minor -->
<!-- change_type: feature -->

## What Changed

Instar gains a new constitutional standard — **Bounded Accumulation: every persistent store must
declare a ceiling and stay under it** — and the first slice of its enforcement. This is the
storage-dimension twin of the existing "No Unbounded Loops" and "Bounded Notification Surface"
standards: it exists because an agent that runs for months accumulates data in append-only logs and
databases that only ever grow, and reading one of those multi-MB files all at once freezes the
single-threaded event loop (the cause of recurring health-check failures and restarts).

This increment is non-behavioral — it adds the substrate without changing how any current store
behaves: a registry that records each store's retention policy, an event-loop-safe segment-rotation
primitive (rename, never read-and-rewrite), a `JsonlStore` accessor that all JSONL persistence will
route through, a growth-burst test that proves retention actually bounds a store on disk, and two
build-time lints that ratchet new violations (a new store must declare a ceiling; a new whole-file
synchronous read of a large store is rejected) while grandfathering the existing tree.

## What to Tell Your User

Nothing changes today in how your agent behaves. This lays the foundation that stops your agent's
on-disk data from growing without bound and stops the kind of large-file reads that briefly freeze
it. The actual trimming of existing oversized files, and the one-time cleanup of data that has
already accumulated, come in the next increments (the cleanup is operator-gated — it asks before
deleting any history).

## Summary of New Capabilities

- A retention policy field on every store in the state-coherence registry (10 stores declared,
  75 legacy categories tracked as a shrink-only backlog).
- `maybeRotateJsonlSegment` (event-loop-safe rename rotation) + `JsonlStore` (the accessor funnel
  with an amortized size-check) in `src/core/storage/`.
- Two CI lints — `lint-store-retention-declared` (a new store must declare a retention policy) and
  `lint-no-wholefile-sync-read` (no new literal whole-file synchronous read of a streamed store) —
  both wired into `npm run lint` over a frozen baseline (only NEW violations fail).
- A growth-burst invariant test that floods a registered store and asserts the on-disk footprint
  stays bounded by the declared policy (and that compliance-hold audit stores never drop their
  oldest segment).
