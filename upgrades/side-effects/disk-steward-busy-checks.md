# Side-Effects Review — Disk steward busy checks no longer stay on forever

**Version / slug:** `disk-steward-busy-checks`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent`

## Summary of the change

`npmBusy` (`src/monitoring/diskSteward/pruneCategories.ts`) now counts:
- install-family commands (install, ci, add, update) for 30 minutes, as before;
- `npm exec` / `npx` only in their first 120 seconds.

The new `npmCacheWriting` checks npm's own `_cacache/tmp/` for an entry changed in the last 120 seconds. An unreadable folder counts as busy. `pruneNpmCache` skips when either check is true.

`xcodeBusy` drops `SourceKitService` from its list.

Evidence (fb-eb8372d8-043): on the Studio, manual prune `a088c852169f4ce5a6f43d38` at 18:33 PT on 2026-11-18 freed 0 bytes.
- npm-cache, 12.5 GB planned, was skipped as `npm-busy`: five `npm exec @playwright/mcp@latest` processes, the newest 18 s old.
- derived-data, 5.6 GB, was skipped as `xcode-busy`: a SourceKitService up 20 h, and no build running.

## Decision-point inventory

- **Whether the npm cache may be cleaned now.** A cache-safety guard. It now reads the cache's own write activity in addition to process names. A wrong "not busy" could break an in-flight `npm exec` start, which retries its fetch.
- **Whether DerivedData may be pruned now.** Same guard, minus SourceKit.

## 1. Over-block

The old checks blocked every run on a machine with agent sessions. That is the defect being fixed. After the change, a fetch-in-progress still blocks, and leftover tmp entries older than 2 minutes do not.

## 2. Under-block

- An `npm exec` that is past 120 s but still downloading is not caught by its command line. `npmCacheWriting` catches it while it writes to `_cacache/tmp/`.
- A fetch that pauses for more than 2 minutes between writes is missed. If the cache is cleared under it, npm refetches, and the worst case is a slower start.
- SourceKit can read DerivedData indexes while Xcode is closed. Clearing them only means reindexing later.

## 3. Level-of-abstraction fit

Same place as before: the steward's own category guards. The cache-state check reads the cache directly, which is the state the guard protects, not the symbol of a process name (Verify the State, Not Its Symbol).

## 4. Signal vs authority compliance

These are guards that block a destructive step (cache deletion), and they fail closed: an unreadable tmp folder or process list counts as busy. They read deterministic state with no judgment. Each one only decides whether to wait.

## 5. Interactions

- PR 3456 (busy skips no longer trip the breaker) makes the auto runs keep trying. With this change, those runs can actually succeed.
- The 60 GB tripwire (CoS msg 67f2d72c) stays as the manual fallback.

## 6. External surfaces

None beyond the disk steward's own prune records and posts, which may now show bytes freed instead of `npm-busy` and `xcode-busy`.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource`. Each machine clears its own caches on its own disk.

## 8. Rollback cost

Revert the commit. No state or migration. The caches simply refill.

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** this changes only guard predicates inside the existing cache prune. It adds no loop, retry or new self-triggered action, and the prune's own cadence and breaker are unchanged.

## Conclusion

The disk steward's cache cleanup can run again on a machine where agent sessions start all the time, while still waiting for real cache writes and real builds.

## Second-pass review (if required)

**Round 1 (independent subagent, 19:16 PT): Concur with the review.**
- The reviewer confirmed in npm's bundled cacache that in-flight blobs and index updates are written as direct children of `<cache>/tmp` and then moved into place (`content/write.js:154-161`, `entry-index.js:72-92`), so `npmCacheWriting` watches the right folder.
- Content is only stored after its checksum verifies, so a fetch caught mid-way fails and can be rerun; it is not corrupted.
- A missing tmp folder means no write: npm creates it before every write.
- pnpm and yarn keep separate stores.
- Removing SourceKit from the list only forces a reindex.
- The reviewer's one nit, that `docs/specs/disk-steward.md` §3.6 still described the 30-minute exec rule, is fixed in this commit, along with its ELI16 line.
