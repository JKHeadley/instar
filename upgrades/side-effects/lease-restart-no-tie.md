# Side-Effects Review — two machines with no shared store stop restarting each other

**Version / slug:** `lease-restart-no-tie`
**Date:** `2026-11-07`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent, four passes (see below)`

## Summary of the change

Tier 1: a bug fix that a revert fully undoes, with no stored data or config to migrate. About 90 lines in `src/` across 4 files, plus tests. Effort: 4 review passes, which is high for Tier 1. Each of the first three passes found a real problem, including a second and third way round the same loop, so the extra passes were earned.

Fixes fb-c51067c6-148. A two-machine agent with no git remote restarted about every 15 minutes, indefinitely (143 restarts on each test server). A machine restarts when its role differs from the role it booted with, so anything that swaps the holder causes a restart, and that restart could cause the next swap. Three separate paths led there:

1. A restarted machine claimed from its own old copy without asking, and tied with the live holder.
2. An agent with no Telegram or app surface had no renew timer. The lease ran out between heartbeats and the peer took it. In the simulated rig that was 15 swaps in 15 minutes.
3. While a peer restarted, the holder could not confirm renewals because the peer was not listening yet, so its lease ran out and the booting peer took it.

Changes, all but one limited to stores that hold only this machine's copy (`LocalLeaseStore.hasNoSharedMedium()`):

- `LeaseCoordinator.acquireIfEligible` asks peers before claiming, whether its copy is expired or missing.
- `LeaseCoordinator.effectiveView`: a same-number peer lease with a later expiry replaces this machine's own expired copy.
- `MultiMachineCoordinator.resilientRenewEnabled`: an omitted setting now means on. An explicit false still wins.
- `LeaseCoordinator.confirmHoldOnPeerPull`, through `noteLeasePeerPull` and the `/api/lease/pull` route: a signed pull extends a held lease in its second half.

Two apply to every store:

- Both contested checks in `MultiMachineCoordinator` ignore an expired or released peer record.
- `LeaseCoordinator.renew` releases the lease when the machine is ineligible, and `installRenewal` stops a slow renewal replacing a newer one.

## Decision-point inventory

- `acquireIfEligible` ask gate: modify, wider on no-shared-medium stores.
- `effectiveView` same-number fold: modify, on no-shared-medium stores only.
- `surfacePullDiscoveredSplitBrain` and `resolveContestedSplitBrain` contested test: modify, adds a liveness condition.
- `resilientRenewEnabled`: modify, a new input on the omitted case.
- `confirmHoldOnPeerPull`: add, renews only. It can never grant a lease that is not already held.
- `renew` eligibility check: add. It releases, and never grants.

## 1. Over-block

A machine now waits as standby behind a holder that is really up, which is the right place to wait. A boot can take up to 10 seconds longer when the peer does not answer the ask. That is bounded, and it fits inside the 20-second tick limit at default settings. A machine that has just restarted cannot claim from a stale copy when its peer answers. If no one answers it claims as before.

A clock running ahead on a dead holder delays takeover by the size of the skew, as it could before for any lease it could see. Measured by the review: 39s with no skew, 336s with five minutes of skew. Tracked in fb-9eb4d9d0-6f0.

## 2. Under-block

The loop can still happen in these cases, all disclosed in the ELI16 and release note:

- Every restart fully down past the 60-second lease: the swaps carry on. From about 35 to 60 seconds it can take a few extra restarts and then settles. Measured: Echo 14s from one sample, Luna about 61s from three auto-update restarts, for a reason not known. That a role restart takes as long is an inference. Luna's current log on this machine shows one role restart and no loop. No number yet for the test pair.
- A machine returning with an expired lease at a higher number than a live holder still claims. One extra restart, then it stops.
- A peer stalling past the 10-second ask causes one more tie per miss.
- Three or more machines can lose sight of a live holder. This is not new.
- Named pools still claim at boot without asking, and a git-backed pair with no remote gets none of the new rules.

All of these are tracked in fb-9eb4d9d0-6f0. <!-- tracked: fb-9eb4d9d0-6f0 -->

## 3. Level-of-abstraction fit

Right layer. The first version was a guard inside `acquireIfEligible`, and review showed that was too high: the machine kept naming itself and serving its dead copy. Moving the rule into `effectiveView` makes every reader of the lease agree. The store reports what it is, and the coordinator decides.

## 4. Signal vs authority compliance

Complies. The signed lease and the epoch remain the authority. A peer's pull is treated as evidence that the link works, the same way a successful push already is, and the signature check and replay guard stay in front of it. Nothing here widens who may hold a lease. An expired record, which the code already said carries no authority, now also cannot cause a tie-break.

## 4b. Judgment-point check

No new static heuristic at a competing-signals point. The second-half limit on pull extension only avoids re-signing every 5 seconds, and changes no outcome.

## 5. Interactions

- Renew timer: more agents now run it, so an agent on `LocalLeaseStore` keeps its lease at one number instead of climbing. The review measured no harm from observe-only machines, single machines or broadcast load. A long peer outage does not produce a restart loop on the survivor (6 simulated hours).
- Self-suspend: unchanged when no pulls arrive. A holder whose peer is really gone still lapses.
- Ineligible holders: `renew` now releases what `acquireIfEligible` was meant to release. This also corrects agents with Telegram or app conversations, whose timer already kept such a holder alive. It is a behaviour change there, in the direction the rule's own comment describes.
- Contested tie-break: the loser now names the winner straight away instead of its own dead copy. `MultiMachineCoordinator-leasePull.test.ts` was updated to match.
- `adoptLateRenewal`: unchanged, and its existing nonce guard is the model for `installRenewal`.

## 6. External surfaces

User-visible: agents on such a pair stop dropping connections every 15 minutes. No new route, config key or file. `/api/lease/pull` keeps its contract, and the served lease may have a later expiry. On a signing fault the pull is still answered.

## 7. Multi-machine posture

This change is multi-machine by nature. Mixed versions are safe: the lease format and signatures are unchanged, and a peer on an old version reads the extended lease normally. A pair where only one side is updated keeps part of the old behaviour until the other side updates.

## 8. Rollback cost

Revert the commit. No state, migration or config involved. Lease files stay valid.

## Conclusion

The three paths to the loop are closed for restarts of the measured length, and proved in a simulation of the real coordinator. The remaining limits are stated rather than hidden. It has not run on real machines yet: the pair is held by the live-proof run, and the fix needs a release plus an update there. That live check is the proof still owed.

## Second-pass review

Independent reviewer, given the code and the measured log but not my conclusions.

- Pass 1, do-not-concur: a live holder could yield to a machine that had declined to claim. Led to the `effectiveView` rule and the liveness check.
- Pass 2, do-not-concur: the cycle survived slow restarts, shown by simulation. It also corrected my lease figure, which is 60s and not 90s. Led to the pull rule.
- Pass 3, do-not-concur: an ineligible holder never gave up the lease, and my stated limit and its evidence were wrong. Led to the eligibility check, the corrected limits, and the guard tests.
- Pass 4, concur: safe to ship with the disclosed limits. An ineligible holder now makes one clean handover with one tombstone and no repeat traffic, including with a Telegram enrolment. Each guard that had no test now fails exactly one when removed. It did not check anything live, the full suite, or an app conversation surface, and did not re-run the grid on the final code, where the eligible path changed only by the nonce guard.

## Evidence pointers

- `tests/unit/lease-restart-no-tie-coordinator.test.ts`: real coordinator, pull loop, tie-break and restart decision.
- `tests/unit/lease-restart-no-tie.test.ts`, `tests/integration/lease-restart-no-tie.test.ts`, `tests/integration/lease-contested-resolution.test.ts`, `tests/e2e/lease-takeover-wiring.test.ts`.
- Tests with each part removed: the pull rule, the renewal rule, the running-machine branch and each guard fail the matching tests, run by me and by the reviewer.
- Simulation, 60s lease, 2 to 3 hours: old code looped at every restart length tried. New code at 13 to 40s down settled in every fixed-start cell (worst last restart 3136s). With random start, 30s and below settled in 6 of 6, 40s took extra rounds in 2 of 6, 50s in 3 of 6, and 62s looped in 6 of 6.
- Measured live on the pair: NRestarts 143 on nimbus and 142 on proof-2 (fb-c51067c6-148).

## Class-Closure Declaration

Class: anything that swaps the holder on a pair with no shared store restarts a machine. Closed for the three paths found, at restart lengths under the bands above. Not closed for downtime past the lease on every restart, or for pools of three or more. Those stay open in fb-9eb4d9d0-6f0, with the live check on the pair as the next review point. The restart decision itself is unchanged, so a future swap from a new cause would still restart a machine.
