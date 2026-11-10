# Side-effects: Conversations release, test and audit harness review

## Summary

PR #3013 adds or changes about 188 paths under `tests/` and `docs/audits/` (171 new, 17 modified); the merge gate counts 169 of them as harness-changing. This note records an independent review of all of them, and three small follow-up changes made from that review:

- `tests/e2e/conversation-graph-live-fixture.test.ts`: the startup timer goes from 45 s to 90 s and the test timeout from 120 s to 180 s. A startup timeout now names the last startup phase the fixture reported and the elapsed time (`live-fixture-start-timeout:<phase>:<ms>`). The test failed once in Local Verify under full load on the M5 and passed alone on the Studio and in three full M5 runs; its code snapshot hashes the declared package roots several times in synchronous code, so its startup time varies about 2x under load.
- `tests/unit/SqliteRegistry-wiring.test.ts`: a duplicate `closeAllSqlite` import is removed.
- The two 2026-11-05 audit files under `docs/audits/` get a one-line header saying they are historical checkpoints, not current state.

## Follow-up after Local Verify (2026-11-10)

The live-fixture e2e kept failing only inside Local Verify's full parallel run. Startup phase logs showed the snapshot copy of ~10,000 files taking up to 69 s on a busy disk, so the test's start window ran out while the fixture server was still copying (the server itself never failed). Changes:
- `tests/helpers/conversation-graph-frozen-dist.mjs`: change detection by path, size, mode and nanosecond mtime instead of hashing the source twice; files copied concurrently with a clone; only the copy is hashed, once; the critical server modules are still compared by content; after the first copy error no worker starts another file.
- `tests/helpers/conversation-graph-live-server.mjs`: a 503 (not ready) first owner visit is retried for up to 30 s; startup phases and a full startup failure are written to `/tmp` so a lane-only failure can be read.
- `tests/e2e/conversation-graph-live-fixture.test.ts`: start window 180 s, child lifetime 300 s, test timeout 300 s; the phase-named timeout error stays.

## 1. Over-block
No issue identified.

## 2. Under-block
The longer startup window could hide a fixture that has become slow. The phase-named error keeps a slow phase visible, and the reviewer's suggested cost cut for the snapshot is tracked as follow-up.

## 3. Level-of-abstraction fit
Test-only and doc-only changes.

## 4. Signal vs authority compliance
No authority changes.

## 5. Interactions
None outside the test files.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable.

## 8. Rollback cost
Revert the commit.

## Class-Closure Declaration
Defect class: n/a. Closure: n/a.

## Evidence
- Full suites on the M5 at 969c81f2b0: integration 6,883 passed, 0 failed; the only unit and e2e failures come from the M5 setup and fail the same way on main there.
- The live-fixture e2e passed on the Studio at fe9030b021 (1 of 1) and in the 5c95b25cca, 2ef62f2048 and 969c81f2b0 M5 runs.

## Second-pass review
**Reviewer:** independent fresh Claude subagent (Opus 5.5), given the diff and the files, not the author's conclusion, 2026-11-09 19:30 PST.

Verdict: concur. All 188 harness paths in the diff (the gate's 169-path list) were reviewed: 171 new files and 17 modified ones. The modified tests contain no weakened or removed assertions; every change follows a real source change (the new `onAccepted` signature, the new journal kind, the vault `syncDurably` interface), and several string-slice checks now end at a named marker instead of a fixed length, which is stricter. The `skipsAdded` flag comes from three env-gated opt-in scale proofs (over 64 MiB HTTP source, 64-member 20,000-row native tail, over 32 MiB metadata pages), each with default-run coverage of the same code at normal size; no failing check is hidden. The new evidence-folder helper, the status-table path-generator rewrite and the prototype-restore wrappers are sound. Notes, none blocking: the opt-in proofs are run by no lane; `SqliteRegistry-wiring.test.ts` had a duplicate import (fixed here); the two 11-05 audit docs are partly out of date (header added here); the live-fixture startup is load- and order-sensitive and its timeout did not name the stalled phase (phase-named error and longer window added here; making the snapshot cheaper is follow-up).

**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 03:47 PST, given the diffs since the first review, not the author's conclusion.

Second verdict, on the follow-up: concur. The snapshot still pins an exact, content-hashed copy of the built package: the source is checked for changes by name, size and nanosecond mtime, the copy is fully hashed, and the critical modules are compared by content, so only a writer that keeps the old mtime could slip a non-critical change past it. The longer start, lifetime and test windows only tolerate disk load, with the phase-named timeout kept, and the 503 retry is bounded and limited to the documented "not ready" answer, so no real refusal is masked. Its one should-fix (cleanup racing copy workers after an error) is applied. Notes kept: the fixed `/tmp` diagnostic names follow an existing file and the phase log is never trimmed.
