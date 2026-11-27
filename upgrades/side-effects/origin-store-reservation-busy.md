# Side-Effects Review — a locked-out recovery reservation answers "not reserved"

**Version / slug:** `origin-store-reservation-busy`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: outbound-message recovery path)`

## Summary of the change

Tier 1, 2 files. `OriginStoreBackend.reserveRecoveryAttempt` reserves the next recovery review of a held/queued Telegram operation inside a `BEGIN IMMEDIATE` transaction, on a store opened with a 25 ms busy timeout. When another connection (a second owner of the same store) held the write lock longer than that, the reservation threw `database is locked` instead of answering. It now catches a SQLite busy refusal and returns `false` — "not reserved", the same answer an operation already reserved by another owner gets. A busy refusal of `BEGIN IMMEDIATE` happens before any statement in the transaction runs, so nothing was spent and the operation stays eligible for a later pass.

Root cause of the CI flake (`tests/unit/telegram-origin/recovery-review-budget.test.ts` › "reserves once across owners and restart", failed on PR #2408's unit shard): two `OriginStore` instances race a reservation on one file and the test expects `[false, true]`; under CI load the loser's lock wait exceeded 25 ms and it threw. Reproduced deterministically by a new test that holds `BEGIN IMMEDIATE` from a separate connection: on `origin/main` it fails with exactly `database is locked`; with the change it returns `false`, then `true` once the lock is released.

Production effect: every caller (`TelegramOriginRuntime` recovery loops) already wrapped the call in a per-operation try/catch that logged "recovery retained operation" and moved on; the behaviour is now the same minus the error log line. Nothing sends that did not before, nothing is skipped that was not before.

Evidence: telegram-origin unit tests 43 files / 369 passed (1 skipped); the race test passes 15/15 under four busy CPU loops; type-check clean.

## Decision-point inventory

`recovery reservation` — modify — a lock refusal now reads as "not reserved" rather than an error. Signal into the existing recovery loop; no new authority.

## 1. Over-block
A reservation refused because of a lock is skipped for this pass — as it already was via the caller's catch. It is retried on the next recovery tick.

## 2. Under-block
Can a reservation now be lost or doubled? Not doubled: `false` never sends. Not lost: a refused `BEGIN IMMEDIATE` wrote nothing, so the operation's schedule is unchanged and it is picked up on the next pass.

## 3. Level-of-abstraction fit
The store method owns its transaction and therefore the meaning of a lock refusal; callers keep their existing error handling for real failures.

## 4. Signal vs authority compliance
No change to who decides; `docs/signal-vs-authority.md` reviewed.

## 5. Interactions
Only `SQLITE_BUSY*` is mapped; every other error still throws and reaches the caller's existing catch.

## 6. External surfaces
None (one fewer warning line in the server log under contention).

## 7. Multi-machine posture
Machine-local by design: a per-machine SQLite store.

## 8. Rollback cost
Revert.

## Second-pass review

**Reviewer:** independent subagent (verdict delivered in its report; recorded here by the author because the artifact did not exist yet when it finished)
**Verdict:** Concur with the review

- All three `TelegramOriginRuntime` callers previously caught the busy throw and skipped the operation; `false` takes the same `continue` path, and nothing is counted before a `true`.
- better-sqlite3's transaction wrapper rolls back whenever the body or COMMIT throws, and in WAL mode a held `BEGIN IMMEDIATE` already owns the write lock, so COMMIT does not return busy. Demonstrated: with another connection holding `BEGIN IMMEDIATE`, the write threw `SQLITE_BUSY` with `inTransaction=false` and no row was written.
- The new test fails on origin/main with `database is locked` and passes with the change; `tests/unit/telegram-origin/` 43 files, 369 passed.
- Noted, not fixed here: about 30 other `.immediate()` transactions in `OriginStoreBackend.ts` can throw the same error when two owners contend past 25 ms (queued as a separate item). Minor: lock contention on a reservation no longer leaves a log line.
