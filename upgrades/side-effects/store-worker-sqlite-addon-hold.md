# Side-Effects Review — origin store holds the SQLite addon for its workers

**Version / slug:** `store-worker-sqlite-addon-hold`
**Date:** `2026-11-08`
**Author:** `Echo helper (M5 Pro)`
**Second-pass reviewer:** `not required`

## Summary of the change

`src/messaging/telegram-origin/OriginStore.ts` gains `holdSqliteAddonForWorkers()`, called in the constructor before the first `spawn()`. It opens and closes one in-memory better-sqlite3 database on the parent thread, once per process, so the SQLite native addon is held by a thread that outlives every store worker. Root cause: Node unloads a worker's native addons when that worker's environment is cleaned up, and the worker's final GC (`Isolate::Deinit` → `InvokeFirstPassWeakCallbacks`) then calls better-sqlite3's weak callbacks in unloaded code, giving SIGSEGV. This killed `tests/unit/telegram-origin/store-retention.test.ts` right after its heaviest test (test 10). Local Verify read the 16 tests that never ran as failures and the dead fork as an unhandled error ("Worker exited unexpectedly"). New files: `tests/unit/telegram-origin/sqlite-addon-hold.test.ts` and `tests/helpers/originStoreAddonProbe.ts`.

Tier 1. Size: 1 src file (+19 LOC), 2 test files. Effort: no spec rounds; reproduction was the bulk of the work.

## Decision-point inventory

No decision-point surface: the change loads a library earlier and never gates, filters or blocks anything.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Remaining crash class: any OTHER worker in instar that opens better-sqlite3 while its parent has not loaded it. The other telegram-origin workers (config reader, detector canary) mention better-sqlite3 only in a comment and never open a database. The `src/core`, `src/monitoring` and `src/scheduler` workers have no direct better-sqlite3 import. No other SQLite worker was found.

---

## 3. Level-of-abstraction fit

Right layer. OriginStore owns the worker lifecycle (spawn, restart, replace, close), so it is the one place that knows a SQLite worker is about to exist. A test-only pin would leave production processes exposed on the stall-restart and replacement paths, where a worker exits while the server keeps running.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It adds no judgment and no authority. It is a load ordering fix.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

---

## 5. Interactions

- **Shadowing:** none. If the addon cannot load, the hold returns false without throwing (`@silent-fallback-ok`). The worker then fails its own startup on the same load and reports through the existing bounded restart and DegradationReporter path, exactly as before.
- **Double-fire:** none. A module flag makes the hold run once per process. Repeated store opens cost nothing.
- **Races:** removes one. Before, whether the addon stayed mapped depended on whether the next store's worker had loaded it before the previous worker finished tearing down.
- **Feedback loops:** none.

---

## 6. External surfaces

None visible. No routes, messages, state or config change. Main-thread cost: one `:memory:` open and close (well under a millisecond) at the first store construction. The server main thread usually already holds the addon through other stores, so in practice this is a no-op there. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: native library residency is a property of one OS process on one machine. No notices, no durable state, no URLs. No status surfaces change.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state, no migration, no agent repair. Reverting would only bring back the rare crash.

---

## Conclusion

The fix addresses the root cause, which the macOS crash report confirms (SIGSEGV in a WorkerThread during `~WorkerThreadData` → `DisposeIsolate` → GC weak callbacks into an unmapped image). It removes a process-crash path from production store restarts as well as the test flake. It is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required (no gate, sentinel, messaging block/allow, or session-lifecycle surface)
**Independent read of the artifact:** not required

---

## Evidence pointers

- Local Verify run logs on the M5 (`.instar/state/local-verify/runs/`): 8 of 256 unit lanes since 2026-11-02 failed with `file-failed:tests/unit/telegram-origin/store-retention.test.ts:16`, each with `isolation-rerun-skipped reason unhandled-errors`.
- The failing PR 2951 run's audit trail (`.worktrees/.verify/runs/87a22cc3f5ef/.instar/audit/destructive-ops.jsonl*`) logs store-retention cleanups for tests 1–10 only. The last one is at 15:27:51.568, and then the file falls silent while other files keep using the same temp folder.
- Signature reproduced: killing a vitest fork right after test 10's afterEach gives 9 passed, 16 pending, and `{"unhandledErrors":1,"messages":["Worker exited unexpectedly"]}`. Local Verify's `parseVitestJson` counts pending as failed.
- The crash reproduced by repeating test 10's work in one process: 8 of 9 runs died (`node-2026-11-08-103802.ips`: EXC_BAD_ACCESS / SIGSEGV, thread `WorkerThread`, `GlobalHandles::InvokeFirstPassWeakCallbacks` ← `Isolate::Deinit` ← `WorkerThreadData::~WorkerThreadData`). With the addon held by the parent: 0 of 9 in the test, and 0 of 6 with the fix in OriginStore.
- `sqlite-addon-hold.test.ts`: without the fix, both behavioural tests fail 3 of 3 (`signal: 'SIGSEGV'`). With it, 3 of 3 pass. The full `tests/unit/telegram-origin` folder plus `no-silent-fallbacks`: 60 files, 606 passed. `tsc --noEmit` is clean.
- Ruled out along the way: CPU load (40 parallel copies, 16 burners), host freezes, disk space, file-descriptor limits, slow worker startup, other tests deleting shared temp folders.
