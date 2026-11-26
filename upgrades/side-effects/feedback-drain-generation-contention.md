# Side-effects review for feedback drain contention

Version slug: feedback-drain-generation-contention
Date: 2026-11-25
Author: Echo
Second-pass reviewer: not required

## Summary of the change

The drain records processing status through the normal generation append. The existing retry could expire after roughly half a second of lock contention. Appends now wait on a monotonic three-second budget with staggered retries. The integration fixture uses an explicit clustering limit while retaining its overall test envelope.

## Decision-point inventory

The existing exclusive generation lock still serializes writes and handoffs. The retry responds to a typed busy result from lock acquisition. The drain compares clustering elapsed time with its existing general budget or the explicit clustering override.

## 1. Over-block

A short wait can now finish successfully. A busy lock beyond the budget still reports an error. Other append errors surface immediately.

## 2. Under-block

The retry cannot grant a second lock. A sustained lock hold still exhausts the budget. The explicit clustering override is capped at 60 seconds, and the fixture uses 45 seconds.

## 3. Level-of-abstraction fit

Retry belongs at the source append boundary because processing-status writes and external intake share that path. The separate clustering allowance belongs on the drain constructor used by the performance fixture.

## 4. Signal vs authority compliance

The filesystem lock remains the authority for write ownership. A busy result only guides when to retry. The override does not change ingestion, clustering, or dispatch decisions.

## 4b. Judgment-point check (Judgment Within Floors standard)

The coordination and elapsed-time checks use deterministic limits. There is no new judgment surface.

## 5. Interactions

The synchronous wait can add up to roughly three seconds to an append under contention. Durable write and compaction semantics remain intact. The default clustering limit is 20 seconds. The large fixture still checks its 90-second and 512 MiB envelope.

## 6. External surfaces

No new operator-facing action or external dependency. Existing generation files and manifests keep their format.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing interface is involved.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The generation lock protects writers using one local store. Existing authority and replication arrangements remain in place. This change does not add notices, durable state types, URLs, or status endpoints.

## 8. Rollback cost

Revert this commit to restore the original retry and fixture budget. No stored data needs conversion.

## Conclusion

The focused regression demonstrates recovery from a 650 ms lock hold. The real multiprocess and 150,000-row performance tests retain concurrent ingest and durability checks.

## Second-pass review (if required)

Not required for this bounded retry and test-fixture override. The lock ownership and storage format are unchanged.

## Evidence pointers

The retained batch stack points from drain processing through markProcessed to generation append. The companion main rerun hit the clustering budget. Local evidence includes the baseline lock regression failure, 22 passing targeted unit cases and two passing integration cases. The 500-row case took 38.38 seconds in the successful integration run.

## Class-Closure Declaration (display-only mirror)

The append retry is shared by the status and intake writers. The optional clustering allowance is limited to its stage and is only supplied by the performance fixture.
