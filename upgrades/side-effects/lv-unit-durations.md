# Side-Effects Review — Local Verify records unit-test file durations

**Version / slug:** `lv-unit-durations`
**Date:** `2026-11-18`
**Author:** `echo (scaling session, topic 145097)`
**Second-pass reviewer:** `Codex, independent, after the merge with main (see "Second-pass review" below)`

## Summary of the change

This is part A of the approved spec `docs/specs/local-verify-borrowed-unit-slices.md` (Chief of Staff, 2026-11-18 15:08 PST). In `src/localVerify/orchestrator.ts`, the per-file duration recording drops its `lane.name !== 'unit'` guard, so unit files enter `file-durations.json`. The unit lane also logs one `unit-wall-factor` row per run. Tests are in `tests/unit/localVerify/orchestrator.test.ts`.

## Decision-point inventory

No decision-point surface. Shard planning (`planShards`) reads the same file, but only a lane's own files, so its inputs for integration and e2e are unchanged. A test asserts identical plans with and without unit entries.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

The recording already exists in the orchestrator for two lanes; this extends it to the third, at the same point and through the same `mergeDurations` caps. No new store.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It records measurements only.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

- **Shard planning:** unchanged for integration and e2e (tested).
- **History file size:** about 94 KB grows to about 315 KB. That is under `DURATIONS_MAX_BYTES` (2 MB), so the file is never refused as oversized, and under `DURATIONS_MAX_FILES` (20,000; about 5,500 test files today).
- **Verifier version:** `orchestrator.ts` is part of the verifier, so the version changes once. Peers and the coordinator need the same release to share work, which is the normal rule for any verifier change.
- **Open work in the same file:** PR 3455 (open) edits other functions in the same file, and PR 3470 only exports a constant from it. There is no overlap in the lines touched.

## 6. External surfaces

There is one new audit row in the run log (`unit-wall-factor`) and more entries in a machine-local history file. Nothing user-visible; no route or config change.

## 7. Multi-machine posture

Machine-local by design. `file-durations.json` is each run machine's own measured history: durations differ per machine (the M5 is about 1.6x faster than the Studio), and each machine plans its own shards from its own numbers. No notices, no durable topic state, no URLs. No status surface changes.

## 8. Rollback cost

Pure code change. On revert, unit entries already in the history are harmless: planning ignores other lanes' files, and the caps bound the size. No migration.

## Conclusion

This is observability needed by later sharding and slice planning. There are no behaviour changes, and it is clear to ship.

## Evidence pointers

`nice -n 10 npx vitest run tests/unit/localVerify/orchestrator.test.ts tests/unit/localVerify/shardPlan.test.ts`: 108/108. Typecheck clean.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.

## Addendum (2026-11-19): maturation ladder entry

`src/data/feature-ladders.json` gains the entry `local-verify-borrowed-unit-slices`, which the spec carried in this PR names. The pre-merge check refused the spec while the entry was missing. Its contents:
- flag `monitoring.localVerify.helper.enabled`, alias `monitoring.localVerify.borrowed`;
- `final: default-off-by-preference`: a helper is someone's personal machine and only its owner enables it (Chief of Staff approval of the spec);
- risk `sensitive`;
- one `dev-agent-live` rung, with a "ran" metric (`borrowed-shadow` rows) and a "harm" metric (`borrowed-shadow-error` rows, at most 3 in 21 days).

This is data only. Registry tests pass, 82/82.

## Second-pass review

**Reviewer:** Codex (`codex exec`, read-only, fresh context, given the change against the new main and the merged files, not this artifact's conclusions), run by the scaling session on 2026-11-19 at about 05:25 PST
**Independent read of the artifact: concur** (second round; the first round objected)

Why a second pass now: the change edits the verifier's lane runner, and the merge line asks for an independent read of any change there. It was also merged with "likely-failing files first" (PR 3497), which rebuilt the same code: a lane may run in two parts, and first parts are sized from the same duration history this change adds unit files to. The conflict was resolved by keeping main's structure, removing the unit exclusion where files are recorded, and writing the wall-factor row from one helper at the three places a lane can complete.

- **Round 1: objected, one must-fix, real, and older than the merge.** When files are re-run alone, the lane's wall time holds the re-runs while the report holds a re-run file's solo time in place of its time in the lane, so the factor of such a run is not a clean sample. Fixed by marking, not correcting: the row carries `reran: true` whenever the lane re-ran files, and `firstPart: true` whenever it used a first part; a reader leaves marked rows out. Nothing reads these rows yet. Tests added.
- **Round 2: concur.** The mark is per lane and cannot leak between lanes that run at the same time; every path that replaces a file's result with a solo result sets it (whole lane, first part, rest). It is conservative: it can be set when a re-run was due but the deadline stopped it.

What the reviewer verified: each reported file is recorded once per run on every path; the row is written at most once and only for a lane that ran to its end with a readable report; unit entries change no first part, no shard plan, no re-run decision and no verdict rule while the history is under its caps. The qualification, now stated in the code comment: past 20,000 files the oldest-inserted entries are dropped whatever their lane, and a history over 2 MB is not read for that run, either of which could change a timed first part or a shard plan. Present size with the unit lane in: about 5,600 files and 0.3 MB (the reviewer counted 3,908 unit and 1,648 integration and end-to-end files); entries of deleted files are never pruned, so the count only grows. No other reader of the history exists in this tree. One reader arrives with PR 3470 (a helper's progress check reads recorded durations): with this change unit files there are judged on their own recorded time and not on the lane's hang deadline, which is the finer and intended reading.

Its notes, not changed here: no test asserts the mark for a re-run inside a first part or inside the rest of a two-part lane (confirmed by reading). Not run by the reviewer: any test. Run by the merger: `tsc` clean; `firstPartFlow`, `orchestrator`, `firstPart`, `feature-ladders-coverage` unit files, 202 tests passed.

**Conclusion, corrected.** The earlier line "There are no behaviour changes" holds with the cap qualification above.
