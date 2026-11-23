# Side-Effects Review — Commitment Review Receipts

**Version / slug:** commitment-consumed-frontier
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** frontier_consumption_review, frontier_scheduler_review, review_connector_reads (read-only source reviews; no tests run by reviewers)

## Summary of the change

Adds a default-off exact local source/batch receipt and separately default-off skip gate. Touches the scheduler, EvolutionManager reserved-action handling, real server wiring, awareness and state registry; adds focused unit, HTTP and lifecycle tests. Tier 1: a reversible dark addition with no live setting, published endpoint, fleet state migration or external effect. A revert fully restores prior behavior and leaves inert machine-local metadata. The change is larger than a narrow bug fix because source continuity, effects continuity and lifecycle races require independent negative-boundary tests. Review took an initial design pass followed by corrective source passes while actual design issues remained; no formal spec-convergence claim. Full verification is delegated to throughput, not represented by targeted results.

## Decision-point inventory

- Source and receipt proof — add: exact stable physical source identity/digest/ranges, not message meaning.
- Typed completed-batch acceptance — add: exact bound successful session/run, all dispositions accounted for, real action evidence, SQLite CAS and live ownership.
- Scheduler no-new-input skip — add: only both literal flags and complete revalidated coverage allow skip; otherwise normal review.
- Reserved action identity — add: cf1 registrations require live mode, actual retained identity and matching immutable intent; ordinary actions unchanged.
- Existing writable/machine/quota/capacity/claim and semantic-review authority — pass through, rechecked across optional source awaits.

## 1. Over-block

Malformed evidence, a missing retained action, history gaps, source instability or bounds exhaustion disable optimization and keep normal review. They do not suppress messages. Reserved cf1 registrations intentionally refuse when off or conflicting instead of blindly creating an action. Legacy registrations keep their behavior. Unknown source principals cannot certify registered outcomes.

## 2. Under-block

Receipts establish exact source coverage and real registered artifacts, not semantic recall, upstream delivery completeness or protection from an actor who can rewrite all trusted local state. An explicit no-action outcome could be a model mistake. Exact complete source coverage is required; large existing histories therefore remain normal review without deliberate historical coverage. No automatic backfill or savings forecast is included.

## 3. Level-of-abstraction fit

The model remains the authority for commitment meaning. The receipt is evidence consumed by the existing scheduler admission path. EvolutionManager owns action idempotence, including retained archive; a lossy replication projection is never evidence. The existing better-sqlite3 dependency supplies crash-safe single-writer CAS, avoiding a stale filesystem lock implementation.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No brittle commitment detector is granted blocking authority. Only exact enumerated unchanged-input proof can avoid redundant work under explicit flags; uncertainty restores normal semantic review. Normal original body, bookmark handling and conditional-effect audit remain intact.

## 5. Cascade / interaction analysis

Ordering: ordinary completion bookkeeping and claim release occur before receipt IO; queue drain waits for receipt cleanup. Same-slug reservations survive all preparation/completion awaits. Delayed terminal reconciliation is bounded to once per trigger and runs after writable/role guards. Reserved receipt session names make unbound/replayed callbacks inert before legacy claim cleanup. Missing definitions clean only exact terminal owned bindings. Duplicate callbacks honor completion fences even after definition removal. Role loss or live flag narrowing cannot promote evidence. Recovery only cleans exact proven terminal orphan artifacts; unknown files neither imply coverage nor consume the in-memory active cap. No new retry timer or extra model call is introduced.

## 6. External surfaces

No external service operation, new endpoint, operator action or live configuration change. Metadata is machine-local and registered with retention/authority declarations. Private bounded batches can contain conversation text; directory0700/file0600, exact owned cleanup and no raw text in telemetry. Receipt proof is bounded to1MiB, source64MiB, recent100 rows and at most128 cleanup candidates. Overflow/error restores normal review. Existing-agent awareness uses the normal awareness registry refresh; flags are absent/off, so no activating migration is needed.

## 6b. Operator-surface quality

No operator-facing action or UI surface is added. Live rollout is separate from this dark capability.

## Conclusion

The initial design was corrected to preserve recent-message review without automatic byte-zero replay, independently revalidate actual action storage, bind real sender/transport identity, refuse disabled reserved identities, and close lifecycle races. Focused tests and independent source reviews cover those boundaries. Publication remains subject to normal gates and throughput's complete suite. No deployment, activation or realized savings is claimed.

## Second-pass review (if required)

Consumption reviewer concurred with source/effect identity and archive retry. Scheduler reviewer concurred after guarded reconciliation and replay fixes. Safety reviewer identified a final duplicate-callback/removal interleaving; it is guarded before missing-definition cleanup and tested. The safety reviewer re-read that correction and concurred; no remaining blocking findings were reported.

## Evidence pointers

Worktree .instar/state/build logs: unit-review-fixes.log, adjacent-final.log, scheduler-final.log, integration-final.log, lifecycle-final.log and lint-final.log. New tests live in tests/unit/commitment-*, tests/integration/commitment-frontier-routes.test.ts and tests/e2e/commitment-frontier-alive.test.ts. Full-suite results are not present and must come from throughput.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is being repaired. Scheduler completion/re-drive changes declare defectClass unbounded-self-action, closure guard, guardEvidence enforcementType ratchet, citation tests/unit/self-action-convergence.test.ts. The faithful commitment-receipt-reconciliation model is registered in src/testing/selfActionRegistry.ts. The control edge is one terminal receipt reconciliation back into ordinary trigger admission. frontierReconciledTriggers permits at most one re-entry per invocation, frontierCompleting and exact session bindings fence duplicates, normal guards rerun, and a pending run remains one per slug. The settling brake is removal of the terminal binding or a skipped ordinary admission; no periodic retry or additional model call is created. Focused executable regression assertions: tests/unit/commitment-frontier-scheduler.test.ts.
