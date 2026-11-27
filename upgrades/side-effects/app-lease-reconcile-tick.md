# Side-Effects Review — Lease reads during app conversation reconciliation

**Version / slug:** `app-lease-reconcile-tick`
**Date:** 2026-11-27
**Author:** Echo
**Second-pass reviewer:** Independent authority and close-path reviewers concurred. Chief’s standing lease review is required before shared verification.

## Summary of the change

Read one narrow lease authority observation per binding reconciliation tick. When the same signed record appears in both inputs, reuse its verification only after comparing the signature and canonical signed payload. Use the non-blocking liveness probe for lost-session candidates. Recheck the conversation, session identity, and current ownership or lease after liveness completes.

## Decision-point inventory

The existing reply and ownership decisions still use their live authorities. The synchronous binding pass uses one current observation for its desired set. The close decision rechecks live authority after the asynchronous process observation. The existing termination authority performs the close.

## 1. Over-block

When an authenticated foreign lease expires, a higher epoch is known without a confirmed holder, or liveness is indeterminate, close attempts wait for positive evidence. An existing app ownership row naming a different machine still supplies the move evidence. A session with a changed identity is reconsidered by a later pass.

## 2. Under-block

A slow registry or one cryptographic check can still take time. The change bounds the number of such operations for a binding pass. Actual termination still uses the existing bounded synchronous write-first kill under its own protected authority. Normal lease maintenance and delivery run through their existing entry points.

## 3. Level-of-abstraction fit

LeaseCoordinator owns signed authority and confirmation. The binding service consumes that decision for one pass and the current decision before close. The app timer has no reason to gather health counters, protocol metadata or endpoints.

## 4. Signal vs authority compliance

The tmux liveness answer is a signal. The app close decision also requires current ownership or a confirmed foreign lease, and the existing termination authority has the final protected-session and write admission checks. See [Signal vs Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

There is no static heuristic replacing a conflicting live decision. The selected lease has to pass the existing cryptographic, time, epoch and self-confirmation checks. Missing evidence holds cleanup.

## 5. Interactions

Each pass reads ownership rows once for its desired set. Cleanup probes run serially, overlap from another tick is skipped, and stop invalidates a pending probe. Closing rechecks that the conversation is live, the local session ID and channel match, and the authority still names another machine. The existing drain window, recent-message protection and write-first termination contract still apply.

## 6. External surfaces

No route, configuration, persisted shape or response schema changes. App bindings can react with less repeated work. Connection timeouts and an unreadable terminal leave close pending for a later pass.

## 6b. Operator-surface quality

No operator-facing screen or approval action.

## 7. Multi-machine posture

Machine-local by design. Each machine reads its own current view of the shared signed lease and its local app bindings. No cache survives a tick. Session cleanup acts on a local incarnation only. The change creates no replicated row, user notice, URL or status response.

## 8. Rollback cost

Revert and release a patch. There is no data migration or configuration reversal. A separately approved local backport would restore its recorded original module bytes if rolling back.

## Conclusion

The change addresses the measured app lease reconciliation path and makes process liveness non-blocking. The exercised sample on Laptop after the repeat timeout and the smaller Studio sample support the same call chain. The latest in-outage Laptop sample identified other workloads as well, so a healthy warm interval and full qualification still matter.

## Independent review

The authority reviewer concurred at `src/core/LeaseCoordinator.ts:773` after the signature and canonical-payload equality check and the higher-epoch and expiry tests. The close reviewer concurred at `src/core/AppConversationService.ts:943` and `src/commands/server.ts:34121` after the exact session identity check. Verified 200 unit, 48 integration and 11 lifecycle tests with TypeScript and exit status 0 on base `42e1e06594751b1b5fc5238c22e311bf027e83da`.
