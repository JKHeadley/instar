# Side-effects: the inventory pass verifies the removal history once, not once per row

## Summary

On the real Studio + M5 pair at 200 records (2026-11-09), removing the stopped M5 finished in about 15 minutes. But the Studio's event loop stalled for 10 to 28 seconds about once a minute during the removal, and for 65 seconds after it. That is longer than the 60-second lease. CPU profiles of two stalls put 95–98% of busy time in `certifiedUnion`. There, `assertMemberLossRepairAllowed` ran once per row, and each call ran `verifiedNegativeRoleLineage()` again. That re-reads and re-verifies every removal signature from disk, so the cost was rows × removal records. The 60-second inventory sweep and the readiness pass both go through `certifiedUnion`.

Two changes:

1. `certifiedUnion` verifies the lineage once before its row loop and passes it to `assertMemberLossRepairAllowed` for every row. `assertMemberLossRepairAllowed` takes an optional `lineage` argument. Every other caller omits it and still verifies at the time of the call.
2. The shared `run()` wrapper of the conversation-graph change router no longer writes a reply once the request timeout has already answered 408. That covers every route in the router: changes, status, pending, preview, cancel, undo, both forget-header routes and erasure status. Before, the late write raised `ERR_HTTP_HEADERS_SENT` after every timed-out request. A handler that fails after the 408 is logged as a warning instead of answered.

Decision point: yes, change 1 changes how often an existing check runs, within one synchronous pass. It adds no check and no authority.

## 1. Over-block
No issue identified. If the lineage fails to verify, every row in the pass is held. That matches the old per-row behaviour, where the same failure blocked each row.

## 2. Under-block
None within a pass. The row loop in `certifiedUnion` contains no `await`, so no other code in this process can change the removal state between rows. Every row is judged against the same verified lineage that a per-row call would have read. A change made by another process during the pass was already a race before this change, since the per-row reads were not atomic either. The next pass sees it.

## 3. Level-of-abstraction fit
The once-per-pass read lives in `certifiedUnion`, the one function the hot callers share (inventory sweep, readiness, coverage, recovery). Import, repair and paged-history paths keep their own call-time verification.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: authority stays with the same verification. Only the number of times it runs within one pass changes.

## 5. Interactions
One lineage read now happens even on a pass with no rows; a failure there is harmless with no rows to judge.
`historicalImportAuthority` absent: no lineage read and no per-row check, as before. The late-reply guard only skips writing to a response that is already finished. A state-changing request (change, undo, cancel, forget-header) still takes effect, and the owner sees it on the next read; after a 408 the client can learn the outcome only by reading the change's status. A longer timeout for these routes is a possible later improvement.

## 6. External surfaces
No wire, page or format change. Fewer server stalls; no `ERR_HTTP_HEADERS_SENT` log lines after a 408.

## 7. Multi-machine posture
Machine-local.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. No new trigger or loop.

## Evidence
- Two CPU call-tree profiles of the live stalls on the Studio (2026-11-09): `certifiedUnion` 98.6% and 99.5%; `assertMemberLossRepairAllowed` 95.5% and 97.8%; `verifiedNegativeRoleLineageCore` 95.7% and 97.8%.
- tests/unit/conversation-graph-replication.test.ts: three certified rows read the lineage once and check three rows; an unverifiable lineage holds all three.
- tests/unit/conversation-graph-change-route-late-reply.test.ts: with the old route the run reports `ERR_HTTP_HEADERS_SENT`; with the guard it is clean.
- The rerun on the real pair is recorded in the handoff note.

## Second-pass review
An independent reviewer read the diff and surrounding code without my conclusion. Concur. It confirmed the row loop is synchronous, row checks never write what the lineage reads, the lineage is deep-frozen, and the failure path lands every row in the same blocked/partial result. Notes applied: the guard covers every route in the router (Summary item 2); late handler failures are now logged instead of silent; one lineage read on an empty pass and the post-408 client gap are now stated in section 5.
