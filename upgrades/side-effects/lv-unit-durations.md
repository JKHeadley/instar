# Side-Effects Review — Local Verify records unit-test file durations

**Version / slug:** `lv-unit-durations`
**Date:** `2026-11-18`
**Author:** `echo (scaling session, topic 145097)`
**Second-pass reviewer:** `not required` (observability only; no gate, dispatch or lifecycle change)

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
