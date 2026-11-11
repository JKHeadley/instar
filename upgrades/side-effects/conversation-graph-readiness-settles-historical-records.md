# Side-effects: the readiness pass settles historical records after one reconciliation

## Summary

After 11cffbe94d, three real Studio + M5 runs at 200 efforts (2026-11-09) still showed the Studio stalling 6 to 13 seconds every 10 to 15 seconds for the whole observation window after a removal had finished. Writes took 25 to 35 seconds and many got a 408 from the request timeout. In the post-removal profiles (run3/prof-post), 54% of busy time was inside `refreshReadinessSteps`, and 50% was `verifiedNegativeRoleLineageCore` reached through `repairLineage`. `receiveHistorical` took 0%, so the pass was not re-receiving records.

Root cause. Only the 'certificate-acknowledgment' loop marks a record settled, and that loop skips every record that has a `materialization`. After a removal, every retained record is historical (materialized). No such record could ever become settled, so every readiness pass, every 15 seconds, took the unsettled path for every record: one removal-history read (the lineage is dropped after each unsettled record, because the next step awaits) and one witness `operation()` round trip. Reconciliation itself had converged, because `reconciledOperations` matched and nothing was written. The work was a steady per-record read cost that never ended. Instrumented run of `graph-member-loss-historical-execution`: both retained records were materialized, certified, and had receipts from every member of their own and the current membership. Each of four later passes made 2 witness `operation()` calls and 2 lineage reads. `settledRecords` stayed at 0 and `reconciledOperations` at 2, with no change from pass to pass.

The change: `settleHistorical` marks a historical record settled in the source-repair loop, both when its witness state matches what was already reconciled and right after it is reconciled. The conditions are: the stored record is materialized and has a certificate or cancellation certificate, and the witness reports it `certified` or `canceled`. The settled key is the same as the existing one, `{entry, descriptor}`, where `entry` is the witness's signed manifest entry from this pass's inventory. The next pass skips the witness call for it and reaches the next record with no await, so the lineage read is shared.

Second change: the graph change route returns at once when the request timeout already answered 408 before the route ran, instead of throwing ERR_HTTP_HEADERS_SENT at `res.setHeader`.

Decision point: this widens an existing cache (settled records) to a record kind it never covered. It adds no check and no authority.

## 1. Over-block
No issue identified. Records that do not meet the conditions keep today's behaviour.

## 2. Under-block
None found. The witness's manifest entry (`recoveryEntry` in GraphWitnessService) hashes the packet, the prepare and erased-control proofs, the certificate, the cancellation and its certificate, the adoption, the rewrap, the erasure and the whole receipt set. That entry is part of the key, so any change at the witness, a new receipt included, makes the next pass reconcile the record again. The two parts of the witness record outside the entry are `stateProof`, which reconciliation already ignored, and `materialization`, which changes only in a membership activation. An activation changes `activeMembershipHash`, so the pass stops at the initial-inventory check, and the new membership comes with a new runtime and empty caches. If the witness changes between this pass's inventory and its `operation()` read, the record settles under the older entry and is reconciled again on the next pass. A new erasure also arrives through the inventory's erasure list, which is applied on every pass before the loop. `erased` records are never settled.

Every settled record is still checked against the removal history on every pass by `assertRepairStillAllowed`, the property `syncRetained` describes. Only the number of reads of that history changes. The final inventory and watermark checks are unchanged. Nothing before a write, receive or commit changes.

## 3. Level-of-abstraction fit
The settle step lives in the loop that already reconciles each record against the witness, next to the cache it fills. The certificate-acknowledgment loop is unchanged.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: a cache of a completed verification, keyed on signed content. No new authority.

## 5. Interactions
It works with 11cffbe94d: once records are settled, the loop reaches each check with no await, so one lineage read serves the pass. That was the steady state 11cffbe94d expected but did not reach after a removal. The route guard runs before any work, so a request that arrives after the 408 does nothing. The client already has its 408 and retries with the same requestId.

## 6. External surfaces
No wire, page or format change. After a removal there are no repeating stalls. A request that arrives after its own 408 makes no change and logs no error.

## 7. Multi-machine posture
Machine-local cache. The witness and peers see one fewer `operation()` read per historical record per pass.

## 8. Rollback cost
Revert the commit. No state or format change. The cache is in memory only.

## Class-Closure Declaration
Defect class: unbounded-self-action (a background pass whose per-record work never converges). Closure: the settle cache now covers every terminal record kind the pass reconciles, both live and historical.

## Evidence
- run3/prof-post (6 CPU profiles taken after the removal): `refreshReadinessSteps` was 54.3% of busy time, `verifiedNegativeRoleLineageCore` via `repairLineage` 49.7%, and `receiveHistorical` 0%.
- Instrumented `graph-member-loss-historical-execution` run, four passes after the removal: 2 witness `operation()` calls and 2 lineage reads per pass, 0 receives, settled 0, reconciled 2, the same on every pass.
- tests/integration/graph-member-loss-historical-execution.test.ts: after the removal's first readiness pass, the next pass makes no witness `operation()` call, reads the removal history once, and checks every retained record with `assertRepairStillAllowed`. All retained records are settled. Red without the fix (2 witness `operation()` calls where none were expected). With it, this file and conversation-graph-replication-runtime.test.ts pass 23 of 23.
- tests/unit/conversation-graph-change-route-late-reply.test.ts, "does nothing when the timeout answered before the route was reached": red (ERR_HTTP_HEADERS_SENT as an unhandled rejection) without the guard, 2 of 2 pass with it.

## Second-pass review
An independent reviewer read the diff and the surrounding code without my conclusion. Verdict: concur with notes. It traced every piece of witness state that the settle key does not cover. Only `stateProof` (already ignored) and `materialization` (changes only with a membership activation, which fails the inventory check and comes with a new runtime) are outside the signed entry. It confirmed that readiness cannot wrongly turn true, because the final inventory and watermark checks run on every pass, and that settling cannot stall it. `assertRepairStillAllowed` still runs for every record on every pass, and the reuse-between-awaits rule from 11cffbe94d holds. The route guard changes no outcome: the old code threw at `setHeader` before `submit`, so a change that arrived late was never applied before either. Dashboard clients retry with the same requestId.

Note applied: my first version also required the stored receipts to cover the record's own membership. The reviewer pointed out this is redundant, because the witness entry already hashes the whole receipt set. It also left the gap that a removed machine that died before sending its receipt would keep those records unsettled, bringing the per-pass cost back in exactly the member-loss case. I checked `recoveryEntry`, confirmed it, and removed the condition. Noted, not changed: that dead-member case has no test of its own. In the unit test, `submitted === 0` documents behaviour rather than the fix (the old code also never reached `submit`). The red signal there is the unhandled ERR_HTTP_HEADERS_SENT. The mobile client's 408 retry was not traced.
