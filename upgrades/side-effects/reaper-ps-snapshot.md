# Side-Effects Review — OrphanProcessReaper reads one ps listing per classify pass

**Version / slug:** `reaper-ps-snapshot`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `not required (no change to what is classified, killed or reported)`

## Summary of the change

Tier 1, one source file (+ one test file). `classifyProcesses` takes one `ps -A -o pid=,ppid=,command=` listing at the start of each pass (cleared in `finally`); `getParentPid` and `getProcessCommand` answer from it and fall back to their old per-pid `ps -p` query when the pid is not in the listing. Found while profiling the conversation-graph event-loop stalls (topic 144559): two of the four longest stalls on the rig were these synchronous spawns (3.5 s each). One commit attempt.

## Decision-point inventory

- Orphan / external / tracked classification — pass-through — same inputs, gathered by one listing instead of per-pid queries.

## 1. Over-block

No block/allow surface change.

## 2. Under-block

No block/allow surface change. The listing is taken a few milliseconds earlier than the per-pid queries were; a parent that changes in that window (reparenting to launchd on exit) could be read as its value at listing time. The kill path re-verifies process identity by start time before signalling (unchanged), so no stale read can cause a wrong kill.

## 3. Level-of-abstraction fit

Right layer: the same helpers, a cheaper source of the same facts.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic.

## 5. Interactions

Tests that script `ps -o ppid=`/`ps -o command=` still get those answers through the fallback (the listing is empty in their mocks). `findAllFrameworkProcesses`, `listAllTmuxSessions` and the kill path are unchanged.

## 6. External surfaces

None.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine inspects its own processes. No state.

## 8. Rollback cost

Revert; no state.

## Conclusion

Ship as Tier 1.

## Evidence pointers

- Rig CPU profile (memo-on run, 2026-11-18 03:25Z): `getParentPid`/`getProcessCommand` → `spawnSync` = 70% of two 3.5 s stalls.
- Tests: `tests/unit/orphan-reaper-ps-snapshot.test.ts`, `tests/unit/orphan-reaper-pane-identity.test.ts`, `tests/unit/OrphanProcessReaper.test.ts` — 17 passed.
