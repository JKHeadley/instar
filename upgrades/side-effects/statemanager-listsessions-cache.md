# Side-Effects Review — StateManager.listSessions read-cache

**Version / slug:** `statemanager-listsessions-cache`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `recommended — touches a core, heavily-used read path`

## Summary of the change

`StateManager.listSessions()` is memoized with a 1s TTL, invalidated on
`saveSession` / `removeSession`. Fixes the systemic CPU hot-loop where it re-read +
re-parsed every session file on every reaper/sentinel tick.

## Decision-point inventory

1. **TTL = 1000ms.** Long enough to collapse the many sub-second redundant calls
   (the churn), short enough that read-only staleness is negligible for the
   consumers (reaper tick 120s; sentinels seconds-to-minutes; scheduler cron).
2. **Invalidate on write, not TTL-only.** A spawn/termination must be visible
   immediately (the scheduler/reaper must not act on a stale view of who exists),
   so every write drops the cache rather than waiting out the TTL.
3. **Return shallow copies.** Prevents a consumer that mutates a returned Session
   from corrupting the shared cache. Consumers already treat the result as a
   read-only snapshot; nested-object aliasing is a non-issue for the scalar fields
   they read.

## 1. Correctness — could a caller see a WRONG session list?

- **A write this process made:** no — `saveSession`/`removeSession` invalidate, so
  the next `listSessions` re-reads. Verified by tests (immediate visibility, same
  clock instant).
- **A write ANOTHER process/machine made:** visible after at most 1s (the TTL).
  This is acceptable: the reaper is two-phase + idempotent-terminate (a vanished
  session is a no-op), the scheduler polls on cron, and the multi-machine layer
  already tolerates file-level races. No consumer requires sub-second cross-process
  session visibility.
- **Sole-writer invariant:** confirmed by grep — StateManager is the ONLY
  in-process writer of `state/sessions/*.json` (all 13 SessionManager call sites
  funnel through `saveSession`/`removeSession`). So in-process invalidation is
  complete.

## 2. Read-only / standby + session pool

`listSessions` is a read; the cache is per-instance in-memory and does not touch
`guardWrite`. On a read-only standby it behaves identically (just caches reads).
Writes remain guarded; the cache is only dropped *after* a write succeeds.

## 3. Memory

One extra array reference per StateManager instance (the cached session list) —
the same objects already parsed; negligible. Dropped/replaced on each refresh.

## 4. Blast radius

Pure internal optimization of one method; no API/route/config surface, no behavior
change. Always-on (not flagged) because it's a correctness-preserving perf fix, not
a risk-bearing feature — the same justification as any cache with write-invalidation.
A second-pass review is still recommended because the read path is load-bearing
(reaper, scheduler, restart, recovery all depend on it).

## 5. Test seam

Constructor gains an optional `{ now?: () => number }` (default `Date.now`) purely
so the TTL is deterministically testable; production callers are unaffected
(unchanged single-arg construction).

## 6. What it does NOT change

- `getSession(id)` (single-file read) is untouched — not a churn source.
- No change to write semantics, atomicity, the read-only guard, or the on-disk
  format.
- No new config, route, migration, or agent-facing surface.
