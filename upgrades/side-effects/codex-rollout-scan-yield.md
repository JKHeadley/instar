# Side-Effects Review — Codex rollout scan runs on a worker thread

**Version / slug:** `codex-rollout-scan-yield`
**Date:** `2026-10-05`
**Author:** `Luna (sagemind) drafted; echo completed`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

instar#2121. `TokenLedger.scanCodexRolloutsAsync` read and parsed up to 500 Codex rollout files synchronously on the server event loop; on a 14 GB / ~54k-file store that blocked the server 8-12 s about once a minute (a CPU profile put ~84% of frozen time here). Discovery, reads and parsing now run in `src/monitoring/CodexRolloutScan.worker.ts`; the main thread only applies the legacy per-file SQLite upserts in the worker's discovery order. Same `listAllRollouts` selection (500, descending mtime), same age cutoff and cwd attribution, same latest-upsert-wins behavior, no cache.

## Decision-point inventory

None. Observability-only scan (read-only over Codex files, writes only the token ledger).

## 1. Over-block

Nothing is refused. An overlapping poll while a scan runs reports zero and starts no second worker; the next poll scans normally.

## 2. Under-block

SQLite upserts stay synchronous on the main thread and can pause behind a competing writer; the rows are small. Selected files are still reread every poll, as before.

## 3. Level-of-abstraction fit

The fix sits at the one place that did the blocking work. The poller and its cadence are unchanged.

## 4. Signal vs authority compliance

No authority. Token observability never gates anything.

## 4b. Judgment-point check

Not a decision point.

## 5. Interactions

A worker error, unexpected exit or 120 s timeout now rejects the scan (logged by the poller's `onError`) where an in-process failure returned zeros; a later poll retries. `close()` terminates an active worker; `finally` resets the running flag. No heap cap on the worker, so one large rollout cannot fail the whole scan (the in-process scan had the main heap). Starting a worker per poll costs roughly 30-50 ms and ~10 MB briefly.

## 6. External surfaces

None visible. `/tokens/*` returns the same totals.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine scans its own Codex store into its own ledger.

## 8. Rollback cost

Revert the commit; no schema or data change.

## Conclusion

A relocation of existing work off the event loop with parity preserved, covered by ordering, re-read, timeout, overlap, failure, shutdown and responsiveness tests.

## Second-pass review (if required)

Two passes on Luna's draft (astra) found three parity breaks (a size/mtime skip cache, changed processing order, batching/limit changes); all were removed. Independent subagent review on the final diff, 2026-10-05: promise settling, close-during-scan, data copy (`ParsedCodexSession` is strings/numbers/nulls) and parity all check out. **Concern raised:** the 512 MB worker heap cap let one oversized rollout fail every file in the scan. Resolved by removing the cap. A second note — the `src`-run fallback to `dist/` could test a stale worker — is covered by `tests/setup/build-dist.globalSetup.ts`, which rebuilds `dist` before every vitest run. Concur after the fix.
