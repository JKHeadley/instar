# Side-Effects Review — a restored Local Verify queue keeps its saved base and re-reads it before the first run

**Version / slug:** `lv-restore-keeps-fresh-base`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end)`

## Summary of the change

Tier 1. In `LocalVerifyService.doRestoreQueue()`, a restored entry's `baseSha` is the saved `e.baseSha` instead of `view.baseRefOid`, and a non-reserved entry's `baseResolvedAt` is `0` instead of the saved value, so `decideBaseRefresh` is true for it and the existing pre-start refresh (local start and peer dispatch) re-reads the base head. Reserved entries (`e.remote`) are unchanged. One source file, one test file.

Why: restore was the one place that used the PR view's `baseRefOid`, which the service elsewhere treats as stale; with a recent saved `baseResolvedAt` and a null in-memory `mainMovedAt`, the first runs after a restart skipped the refresh and tested on an hours-old `main` (2026-11-13 18:50Z: PRs 3137 and 3096, both failed).

## Decision-point inventory

`decideBaseRefresh` (whether to re-read the base before a start) is unchanged; restored entries now reach it with an input that makes it answer yes. No gate, block or merge decision changes.

---

## 1. Over-block

None. Nothing is refused. A restored entry's first start does one base-head read and one open-PR read it previously skipped.

## 2. Under-block

A reserved entry still carries the base it was dispatched with across the restart; that is required (its peer result is matched against that snapshot). If the base-head read fails at the pre-start refresh, the run uses the saved base: as old as the last resolution before the restart, not older.

## 3. Level-of-abstraction fit

The refresh mechanism already exists and is the right owner of "which base"; restore now feeds it instead of deciding the base itself from a field the service documents as stale.

## 4. Signal vs authority compliance

No authority added or moved.

## 5. Interactions

- **`already-recorded` and `head-or-base-moved` drops at restore:** keyed on head and base branch name, not on `baseSha`; unchanged.
- **Start ordering:** a restored entry's start now goes through `refreshBaseThenPump` (the slot is held by `this.starting` meanwhile), the path every waited entry already takes.
- **Durable queue:** `persistQueue` writes `baseResolvedAt` only when truthy and the reader maps non-positive values to undefined, so `0` never reaches disk or comes back as a time.
- **Spawn/kill:** none. Class `unbounded-self-action`: not applicable.

## 6. External surfaces

Audit log: `base-refreshed` (or `base-refresh-failed`) now precedes the first `started`/`peer-dispatch` after a restart. `GET /local-verify` is unchanged in shape.

## 7. Multi-machine posture

The queue is machine-local to the lease holder by design. The fix covers both the holder's local start and its dispatch to a peer; the peer runs the base it is handed.

## 8. Rollback cost

Revert the commit. No migration: the durable queue format is unchanged.

## Addendum: a peer's red run records its detail locally

`finishPeerAttempt` (the peer side) now audits `run-detail` with `source: "peer-run"` and the attempt id when the record is not a success (or was flaky). Observability only: no decision reads it, nothing is sent to the coordinator, and the peer result payload and its validation are unchanged. Bounded by `runDetail` (40 reasons, 30 failures), the same bound as a local run's row. Over-block / under-block: not applicable. Multi-machine: the row is machine-local by design; reading it means reading the peer's `logs/local-verify.jsonl` (carrying it to the coordinator would change the peer wire format and is tracked as fb-fc240295-598). Rollback: revert. Added after the second-pass read below; covered by one new unit test.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), read-only, 2026-11-13.

Verdict: "Concur with the change", no blockers. It confirmed: `0` forces the refresh on both the local start and the peer dispatch path, and nothing else reads `baseResolvedAt` as a time; `refreshBaseThenPump` cannot leave an entry stuck or loop (both reads are caught, the slot guard is released unconditionally, each entry refreshes once, the fallback is the saved base); `view.baseRefOid` at restore was a leftover from before the `baseHead` seam existed (drop rules, record keys and replay keys do not use the base sha); start ordering and the boot-time starved alarm hold; none of the other test files that boot a service over a saved queue depends on a synchronous restored start or on the view's base.

Acted on: `decideBaseRefresh` now answers yes for `baseResolvedAt === 0` explicitly instead of relying on the clock being far from zero (two assertions added); the orphan-reap test flushes before its negative assertion, which could otherwise no longer fail; one more restored-start test flushes explicitly. Recorded, not built here: no test takes a restored entry through the peer dispatch path (the decision it shares with the local path is covered); a reserved entry whose peer attempt is abandoned after the restart can still start locally on its dispatch-time base without a refresh if that was under five minutes ago, as before this change.

**Reviewer concurred:** yes.
