# Side-Effects Review — Planned restart admission follow-through

**Version / slug:** `planned-restart-admission-follow-through`
**Date:** 2026-11-27
**Author:** Echo
**Second-pass reviewer:** Independent restart review concurred on base `f3dd3d2a`.

## Summary of the change

Keep the peer lease ceiling and expose the measured requirement when it exceeds that ceiling. Require positive solo evidence before allowing a preferred host without a lease coordinator. Order restart requests under their existing file lock. A live versioned update keeps its activation details. An unversioned operator force transfers its bypass to the selected request in either arrival order. Force tied to a specific update stays with that release. If an exact verification deferral had extended a now-expired update, the combined request takes the force request's live expiry because the old proof does not cover the combined bytes. Durable restarts survive role withdrawal, and a timed-out request yields to eligible work. Both consumers keep the active request and log unexpected admission errors.

## Decision-point inventory

The peer ceiling and hold policy still control real pools. The coordinator-less admission path permits only the existing single-host case or positive solo evidence for the configured local holder. The common writer preserves an active update ahead of a durable ordinary restart, which outranks a withdrawable role request. An exact verification deferral extends delivery using the same evidence checked by the supervisor.

## 1. Over-block

A configured holder with unknown peer membership must wait. An ordinary request can share an already queued update restart. A standalone machine with positive local-only proof can proceed. Expired requests without an exact deferral proof and exact timeout markers yield to valid replacements.

## 2. Under-block

Admission depends on compatible runtime versions and verified topology on each machine. If the measured boot requirement remains above the peers' ceiling, the policy still holds. The local writer serializes cooperating processes on one host. It does not grant restart permission to arbitrary writes made outside the supported publisher.

## 3. Level-of-abstraction fit

LeaseCoordinator owns measured lease capacity and confirmation. Server and lifeline consumers retain their existing shutdown authority. The restart file lock makes ordering a machine-local publication decision. The exact verification deferral is read by the publisher and supervisor through the same dependency leaf.

## 4. Signal vs authority compliance

The observed window is a diagnostic signal. It cannot increase the signed peer ceiling. The existing admission authority makes the decision using verified lease and topology evidence. The file lock protects exact current publication state. See [Signal vs Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

There is no new heuristic that overrides a competing authority. Peer policy remains binding. Role updates and activation requests have explicit, deterministic precedence because role-only flags may be withdrawn and a versioned restart has independent lifeline obligations.

## 5. Interactions

The publisher checks precedence after both the lease-announcement and file-lock waits. Terminal markers apply only to their exact flag. A role promotion carried by a pre-existing restart preserves its ID, can refresh its verified lease time, and does not advance the cooldown for an actual role publication. Consumers are still allowed to claim only the same active request. Unexpected errors keep the request until the existing deadline.

## 6. External surfaces

The operator's forced restart can release an update held by Local Verify while preserving the target version. Request ordering, retained role work, restart reconciliation and awaited pair-activation publication are active with lease admission off. Logs name both the measured requirement and peer ceiling and retain unexpected consumer errors for diagnosis. The read-only admission response keeps its existing shape.

## 6b. Operator-surface quality

There is no new approval screen or operator-only action.

## 7. Multi-machine posture

The writer flag, promotion evidence and local supervisor logs are machine-local by design. Signed lease authority and peer ceilings still come through the existing mesh. No URL, user notice, or new replicated record is created. No health or status response schema changes.

## 8. Rollback cost

Revert and release a patch while admission stays off. Existing readers still see the role stamp's original event time. The older writer does not consume the new optional verification timestamp. Keep the server, lifeline and publishers on a compatible head before enabling the guard.

## Conclusion

The independent reviewer verified the exact restart delivery proof, precedence, and promotion evidence. Focused verification is required against the published tree. The mixed-version admission flag stays off until the documented runtime and rehearsal conditions pass.

## Independent review and verified scope

Concurred on the scope at `f3dd3d2a1882e740a78e6c410c2ba87aca1c0551`. The exact-delivery proof is in `src/core/plannedRestartDelivery.ts` and is shared with the supervisor by `src/core/PlannedRestartVerifyGuard.ts`. The writer's precedence and the marker decision run under the file lock in `src/core/restartRequestFile.ts`. `src/core/roleFollowRestart.ts` keeps original promotion time, refreshed evidence and actual publication cooldown distinct.

TypeScript and 398 unit tests passed. Thirty-six integration and 32 lifecycle checks passed after updating the stale-response fixture to publish a genuinely newer request while the prior admission check was in flight. The fallback threshold remains 493. No live enablement, version change or production restart was performed.
