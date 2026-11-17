# Side-Effects Review — disk steward: a collected cleanup counts its recovery once

**Version / slug:** `disk-steward-recovery-once`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`DiskSteward.recordPrune` adds a cleanup's observed recovery to the latest sample, so the forecast can leave that freed space out of the trend. A finished run's `run.json` is never cleared. So at every server boot, `pruneRunner.recover()` returns the same result as `collected`, and `adoptRecoveredResult` recorded it again.

On the Mac Mini on 2026-11-16, run `24911832381ddf70973b9c52`, which freed 9.2 GB, was recorded on five samples. That gave −41 GB/day and "2.1 days to the floor", while the raw trend was −10.4 GB/day.

The fix: the steward keeps the ids of runs it has recorded (`recordedRuns`, the last 20) and records each run once. A state written before this field existed falls back to `lastPrune.runId`, so the Mini's next boot does not count its last run again. Duplicates already on disk age out of the 24-hour window within a day.

Files: `src/monitoring/DiskSteward.ts`, `tests/unit/diskSteward.test.ts`.

## Decision-point inventory

- `recordPrune`: **modify**. It is now idempotent per run id.

---

## 1. Over-block

This change has no block or allow surface. A run with the same id as a recorded one is skipped. Run ids are 24 hex characters of randomness, so a distinct run is never mistaken for a recorded one.

---

## 2. Under-block

A run collected at boot that was never recorded is still recorded, as before.

---

## 3. Level-of-abstraction fit

The fix is where the double count happens, in the recorder. The runner is unchanged; clearing `run.json` instead would also change its stale-run and corroboration logic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No: this change produces a signal consumed by an existing smart gate.

The forecast is a signal, and this makes it accurate. Nothing decides differently except through the corrected forecast.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is involved.

---

## 5. Interactions

- **Breaker:** the cleanup-not-helping breaker counted the same run again at each boot too. It now counts the run once.
- **lastPrune / sizes:** a re-collected run no longer overwrites `lastPrune`, `sizes` or `wholeDisk` with the same values. Those are identical anyway.

---

## 6. External surfaces

- The forecast at `GET /disk-steward` and in disk notices drops from inflated to real after a restart.
- Persistent state gains an optional `recordedRuns` array.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing action. The notices simply carry the right number.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

This is **machine-local by design**: each machine's disk and its own steward state.

---

## 8. Rollback cost

Rolling back means reverting the code. The extra field is ignored by the old code.

---

## Conclusion

This fixes a false "disk full in two days" forecast found on the Mac Mini. Clear to ship.
