# Side-Effects Review — planned restarts wait for accepted peer verifications

**Version / slug:** `planned-restart-peer-attempt-hold`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** independent reviewer subagent, see below

## Summary of the change

Tier 1, reversible by a code revert. Spec: `docs/specs/planned-restart-local-verify-hold.md` (peer amendment, converged 2026-11-04, cross-model review degraded in all 3 rounds). Size: 2 source files, about 140 lines; 4 test files. Effort: 3 spec rounds, 1 build.

`LocalVerifyService` publishes `state/local-verify/peer-hold.json` at the start of every tick while an accepted peer attempt qualifies (lease held, epoch equal, `accepted`, successful peer contact within two minutes) and removes it when none does. `plannedRestartVerifyState()` folds that heartbeat into its existing `hold`, so the supervisor, the foreground watcher, `markPlannedRestartDeferred()` and `notePause()` inherit the wait unchanged. `tick()` now calls `notePause()` first so a slow reap cannot delay the heartbeat. The heartbeat is also written at peer accept and at record import. New audit events: `restart-held-for-peer`, `restart-peer-hold-ended`, `peer-hold-write-failed`. An end event can be missing when the server restarts before its next tick; `boundAt` on the held event and the following abandon give the residual.

Measured reason: lease-changed abandons after own restarts cost 115.9 peer-minutes on 11-04 evening and 112.0 overnight; 55–61% of those followed update restarts, and 2 of 2 (28.0 minutes) on 11-05 morning. The ceiling is an estimate of what this can recover, not a measured saving.

## Decision-point inventory

- Planned restart consumption (supervisor, foreground watcher) — modified: a fresh heartbeat with an unexpired attempt also defers an ordinary planned request.
- Verifier lists an attempt in the heartbeat — new: four typed conditions combined with AND.
- Combine local and peer holds — new: later bound, capped at the request's three hours.
- Lease fence on peer attempts — pass-through, unchanged.
- Merge authority, peer dispatch rules — pass-through. Peer dispatch already pauses while a restart is pending.

## 1. Over-block

A peer that answers polls but never finishes holds a planned restart for at most 21 minutes from dispatch. With no chaining (dispatch pauses once a request exists) this is one per peer, so an update is delayed at most 21 minutes per request, and the request also has its existing delivery window. Measured: 2 of 414 attempts took longer than 21 minutes; those are still discarded, as today.

## 2. Under-block

Does not cover same-holder lease lapses (`lease-lost` then re-acquire) or unplanned restarts: 39–45% of the discarded minutes in the two larger intervals fall there. Those are a different cause and stay measured in the throughput ledger. An attempt still `sending` is not held until it becomes `accepted`, which can leave the time from dispatch to accept (median 0.7 s, maximum 29 s) unprotected. A request and a consumer check can also fall between a verifier tick and the accept write; that fails open.

## 3. Level-of-abstraction fit

Right layer. Only the verifier knows the live lease and the peer's last answer, and consumers can only read files, so the verifier publishes and the existing guard decides. No new restart controller.

## 4. Signal vs authority compliance

Deterministic invariant over typed facts with arithmetic bounds, not a judgment. Unreadable or stale input never defers. `bypassHolds` still overrides. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

None added. The 21-minute and 90-second values are constants derived from the audit stated in the spec.

## 5. Interactions

- **Existing local hold:** later bound wins; a local-only hold keeps its original bound exactly (existing tests unchanged).
- **Delivery window:** a peer-only hold writes the deferral sidecar, so an update's TTL does not drop the request while it waits. Tested.
- **`notePause()` order:** moved ahead of `reapOrphan()` and `recheckVerifierHold()` in `tick()`. It reads state and accrues paused time only; neither later step reads what it writes.
- **Overlapping ticks:** rename is atomic and the writer is idempotent.
- **Peer breaker:** untouched. A breaker opening does not clear `lastPollOkAt`; the two-minute rule drops the attempt independently.
- **Peer role (`peerOnly`):** has no reserved entries, so it writes nothing.
- **Rollout:** the supervisor is long-lived and ignores the heartbeat until it restarts on new code, which is safe in both directions.

## 6. External surfaces

Timing: a routine restart can wait up to 21 minutes for a peer run, and new local and peer verifies stay paused during that wait, as they already do for any pending planned restart. One new machine-local file, written about every 30 seconds while peer work is in flight; no I/O when idle. No routes, no config, no message changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, inheriting the lease-holder-only Local Verify posture (`docs/specs/green-pr-automerge-enforcement.md`, `docs/specs/local-verify-merge-authority.md`). The decision gates this machine's own restart, for attempts this machine dispatched under its own lease. A standby writes no heartbeat, and a file left after a lease loss expires in 90 seconds.

## 8. Rollback cost

Code revert and a patch release. The heartbeat file is then ignored and can stay. No migration. Agents on older code keep today's behavior.

## Conclusion

Narrow extension of an existing guard. All inputs fail open to today's behavior. The accepted residual: a restart may wait up to 21 minutes per request, and same-holder lapses remain.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, read-only.
**First read: concern raised, no safety defect.** It traced three gaps: the `bypass` end reason could never fire because the bypass writer stamps a new `requestedAt`; `bound-reached` was usually lost when the request was consumed first; a new attempt had up to 30 seconds with no heartbeat. All three fixed with regression tests. It also corrected three wording claims in this artifact, now fixed. It concurred on the sidecar and TTL path, heartbeat staleness, polling during a pause, the `notePause` move, null lease-epoch comparison, re-audit on a new request, and no chaining. Its concerns were design-level and are resolved by the changes above; no second read was run on the fixes.

## Evidence pointers

- Measurements: `.instar/reports/throughput-improvement/2026-11-05-pass8.md`, `-pass9.md`, `-pass10.md`.
- Unit: `tests/unit/planned-restart-verify-guard.test.ts` (9 new), `tests/unit/localVerify/peerVerifier.test.ts` (11 new). Integration and E2E: one new case each.
- Integration and E2E cases passed as temporary copies in the targeted unit lane, because their own configs use the full-suite slot; the verifier runs them in place on the exact head.
- Mutation: disabling the peer hold in the guard fails the integration case at "performGracefulRestart not called".

## Class-Closure Declaration (display-only mirror)

The modified restart controller has a bounded recheck path rather than a new self-trigger loop. `defectClass: unbounded-self-action`; `closure: guard`; `guardEvidence: { enforcementType: ratchet, citation: tests/unit/planned-restart-verify-guard.test.ts }`.
