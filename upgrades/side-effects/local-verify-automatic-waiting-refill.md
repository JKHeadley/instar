# Automatic waiting-list refill side-effects review

## Summary
Tier 1, narrow reversible queue-service repair. One bounded coordinator driver reuses admission; no persisted schema, cap, process limit or green-verdict changes. Actual normal-enforcing focused results: 23 unit, nine HTTP integration and eight production-wiring lifecycle checks passed, all three commands exit zero with no skipped cases. Final build and ordinary npm prepare completed with exit zero. Complete exact-head verification remains required before merge. A diagnostic baseline reproduced the intended missing-refill assertion, but ran in dry-run posture because the first driver used the wrong enforcement variable. That result is retained and is not represented as normal-enforcing evidence. Focused GREEN must use INSTAR_HOST_TEST_ENFORCE=1.

## Over-block
Healthy readable requests behind transiently unreadable requests could otherwise starve. Automatic offers temporarily ignore those unreadable reservations for 120 seconds while preserving their durable first refusal. Ordinary caller admission and stale/drop rules remain unchanged. Five offers and a thirty-second cooldown bound work; very large waiting lists may take several ticks to refill.

## Under-block
The waiting list still has its existing 200-entry cap, thirty-minute freshness and six-hour healthy-idle expiry. A request not refreshed by its owner or watcher can become stale and will not be automatically resurrected. This repair does not make draft readiness or operator approval decisions; existing hold and merge checks continue to own those decisions. No claim that queue admission makes a PR mergeable.

## Level-of-abstraction fit
LocalVerifyService owns durable waiting, operator ordering and admission. Its tick is the appropriate consumer of the existing WaitingList; no second scheduler or direct queue-file writer is introduced.

## Signal versus authority
The driver sends normal requests and records waiting-auto-offer audit signals. The existing request path still decides admission, and the existing complete-suite record and merge gates retain merge authority. The internal waitingRefill option is not accepted by the HTTP parser. Reference: docs/signal-vs-authority.md.

## Interactions
Operator pending fronts/releases run before refill. Overlapping ticks share a guard. Capacity is checked synchronously after all asynchronous PR/base reads; insertion follows without another await. After all asynchronous reads, the automatic request rechecks stopped state, operator hold, identity and freshness of the original waiting object, health and coordinator lease before any in-flight cancellation, queue replacement or index mutation. No await follows this recheck before insertion. A transient unreadable request gets bounded backoff rather than deletion. The driver does not consume operator overflow, remove holds, invoke a full suite, or change ordinary queue ordering.

## External surfaces
A full-queue POST remains HTTP 429 for compatibility and still persists the waiting request. Its request no longer depends solely on the caller retrying while live. GET continues to distinguish waiting from admitted entries. The new audit rows identify each automatic offer and its result. Network reads are bounded to five candidates per pass. No user data or credentials are added to the audit.

## Multi-machine posture
Machine-local by design, like the existing queue and waiting file. Only the serving-lease coordinator refills. A peer-only service and a machine that loses ownership admit nothing through this driver; the request recheck handles ownership loss during reads. Durable waiting remains in the coordinator's existing state lifecycle; this change adds no replication promise or cross-machine merge authority.

## Rollback cost
Revert the source change and redeploy normally. The existing waiting-file schema is unchanged and remains readable. In-memory backoff disappears on restart; no external action or data migration needs reversal.

## Second-pass review

**Reviewer:** /root/distributed_train (final independent static review); /root (source and race review).
Root independently reviewed frozen manifest d581bbc5cc9b2f905aa09cd25f776ee39b23e45544404afa5e50262d96ed5704 and concurred: same-Waiter identity and freshness, stopped/hold/health/lease revalidation precede post-read queue mutation with no later await; bounded backoff avoids first-five starvation while retaining original age and retry priority; hold and shutdown races are covered. The diagnostic baseline remains explicitly non-enforcing; approved focused GREEN uses actual INSTAR_HOST_TEST_ENFORCE=1.


Final independent static review by /root/distributed_train: Concur with the review. The reviewer read the actual runtime and three-tier test deltas, ELI16, release note and raw focused logs/results; verified unchanged runtime/test hashes; confirmed actual enforcing 23/9/8 passes with zero skips and three exits zero; and found no cap, hold or full-gate authority weakening. The reviewer ran no tests and made no author edits. The diagnostic dry-run RED remains honestly disclosed.
