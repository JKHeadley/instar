# Side-effects: the readiness pass reuses one removal-history read between awaits

## Summary

After fb1e517744 fixed the inventory sweep, a second real Studio + M5 run at 200 records (2026-11-09) still stalled the Studio's event loop for 15 to 30 seconds after a removal. Across the 19 CPU profiles from that run, 47% of busy time was `assertMemberLossRepairAllowed` called from the readiness pass `refreshReadinessSteps` (29.1% through `assertRepairStillAllowed`, 17.9% where that call was inlined). Each manifest entry read and verified the whole removal history from disk again through `verifiedNegativeRoleLineage()`.

The change: in the readiness pass's source-repair loop, the removal history is read once and passed to `assertRepairStillAllowed(record, lineage)` for following records. It is reused only while no `await` has happened since it was read. Any branch that awaits (asking a peer for a missing record, witness recovery, and everything after a record that is not yet settled) drops it first, so the next check reads it again. `ConversationGraphReplication` gains `repairLineage()`, and `assertRepairStillAllowed` takes an optional lineage. With no lineage it verifies at call time, as before.

In the steady state after a removal, every record is settled and the loop reaches each check with no await, so the pass does one read instead of one per record.

Decision point: this changes how often an existing check reads its input within one synchronous stretch. It adds no check and no authority.

## 1. Over-block
No issue identified. If the history fails to verify, the read throws inside the pass's try block and readiness stops at 'source-repair', the same result the per-record call gave on its first record.

## 2. Under-block
None. A lineage is only reused between records reached with no await since it was read, so no other code in this process can run between the read and its use. A removal that completes during an awaited witness or peer call is seen, because every awaited branch clears the cached lineage and the next check reads it again. A change made by another process was already a race with the per-record reads, which were not atomic either.

## 3. Level-of-abstraction fit
The reuse lives in the one loop that showed the cost. `assertRepairStillAllowed` keeps its call-time behaviour for every other caller.

Not changed, on purpose:
- `receiveHistorical` (site 2) and `validMaterialization(record, true)` → `currentHistoricalImportMembership` (site 3). Every caller awaits `receiveHistorical` once per record, inside the source's serial queue, so a lineage cannot be shared across calls. In the same 19 profiles they were about 1.1% of busy time in total: `assertMemberLossRepairAllowed` inside `receiveHistorical` 0.80%, `currentHistoricalImportMembership` from `receiveHistorical` 0.14% and from `verifyDurableHistoricalImportCore` 0.19%. Within one call, the first two reads could share one lineage, but the saving is under 0.5% and the final post-write recheck must stay fresh.
- The 'certificate-acknowledgment' loop has no lineage read of its own. Settled records `continue` with no work; the rest await witness calls per record, and the lineage read inside `persistCertificate` was 0.07%.
- `assertPositiveCustody` (peer-frontier `historicalMembers`, about 4.5%) reads the lineage a few times per call, not per record. It is a separate, later item.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: the same verification keeps authority. Only the number of times it reads its input changes.

## 5. Interactions
With no historical authority installed, `repairLineage()` returns null and each check stays a no-op, as before. The readiness pass runs under the runtime's mutation lock, which does not change.

## 6. External surfaces
None. No wire, page or format change; fewer server stalls after a removal.

## 7. Multi-machine posture
Machine-local.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. No new trigger or loop.

## Evidence
- 19 CPU profiles from the second Studio + M5 run (2026-11-09, 09:40 to 09:58): busy time under `verifiedNegativeRoleLineage` was 51–83% per stall after the removal; 47% of all busy time came from the readiness pass's per-record check.
- tests/integration/conversation-graph-replication-runtime.test.ts, "verifies the removal history once per readiness stretch and reads it again after any await": three settled records take one read; with the middle record unsettled (so the pass awaits the witness) the pass takes two reads, one before and one after the await, and the record after the await is checked against the second read; a history that fails to verify stops readiness at that read and no record is checked. 22 of 22 tests in the file pass.

## Second-pass review
An independent reviewer read the diff and the surrounding code without my conclusion. Concur. It traced every path through the loop (missing record, witness recovery, settled `continue`, reconciled `continue`, `return false`, exceptions) and found no path where a lineage is used after an await since it was read. It confirmed an unverifiable history fails at the same point as before and that no-authority behaviour is unchanged. It agreed the certificate-acknowledgment loop and `receiveHistorical` must stay per record; sharing the two reads inside one `receiveHistorical` call is possible but optional.

Notes applied: the test now checks that the record after the await used the second read, and that the failing-history pass stops at that read with no record checked. Noted, not changed: a removal history written to disk by another process during a no-await stretch is seen at the next read, the same assumption fb1e517744 made; it holds as long as only this server process writes that history. The missing-record branch's reset is covered by reading, not by its own test.
