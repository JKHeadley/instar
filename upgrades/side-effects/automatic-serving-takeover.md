# Side-Effects Review — Automatic serving takeover cadence

**Version / slug:** `automatic-serving-takeover`
**Date:** `2026-07-24`
**Author:** `Instar-codey`
**Second-pass reviewer:** `serving_takeover_review`

## Summary of the change

`LeaseCoordinator.peerTakeoverEligible()` exposes the existing fenced lease
authority's current acquire verdict as a scheduling hint.
`MultiMachineCoordinator.tickLeasePull()` uses that hint after a verified peer
observation to wake the existing lease tick. This removes the unrelated
two-minute heartbeat phase delay after stale-holder evidence becomes sufficient.
When that authority grants the preferred machine a peer takeover,
`LeaseCoordinator` records the won epoch process-locally so the existing
solo-captain renewal path can keep that exact epoch alive before the slower
registry-death threshold. No new acquisition authority or evidence type is
introduced.

## Decision-point inventory

- `FencedLease.canAcquire` via `LeaseCoordinator.peerTakeoverEligible()` —
  pass-through — reads the existing expired/dead/non-renewing-holder verdict
  without writing state.
- `MultiMachineCoordinator.tickLeasePull()` — modify — schedules the sole lease
  actor when the existing authority says a peer takeover is eligible.
- `LeaseCoordinator.acquireIfEligible()` — pass-through — remains the only
  normal takeover authority and re-evaluates eligibility before its fenced CAS.
- `LeaseCoordinator.soloCaptainHoldEligible()` — modify — accepts either the
  existing all-peers-presumed-gone proof or an epoch-bound record that this
  process already won a peer takeover through the same fenced authority.

---

## 1. Over-block

No new rejection or block path is added. An observe-only machine continues to
refuse acquisition inside `tickLease`; a preferred healthy peer continues to
win through the existing lease rules. A healthy renewing peer produces
`peerTakeoverEligible() === false`, so the new scheduling edge is inert.
The solo-renew path cannot activate without first winning a fenced peer takeover
and cannot apply to any other epoch.

---

## 2. Under-block

The change cannot recover if the standby event loop or process is down, if no
authenticated peer lease has ever been observed, or if the active pull loop is
disabled/unavailable. Those cases retain the existing out-of-process watchdog,
heartbeat tick, and fail-closed unknown-evidence behavior. A complete network
partition can still delay takeover because absence of a verified observation is
not treated as proof. A preferred captain that restarts while still isolated
forgets the process-local takeover authorization and fails closed to the slower
all-peers-presumed-gone path.

---

## 3. Level-of-abstraction fit

This is at the coordinator scheduling layer. The fast peer-pull loop already
owns authenticated observation cadence, while `LeaseCoordinator` and
`FencedLease` own evidence evaluation and acquisition. The pull loop consumes
the authority's hint and wakes the existing actor; it does not duplicate nonce,
expiry, liveness, preference, or CAS logic.
Solo renewal remains in `LeaseCoordinator`, where the acquisition provenance and
current epoch can be checked together.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

`peerTakeoverEligible()` is a read-only scheduling signal produced by the
existing deterministic lease authority. The constrained lease domain is fully
enumerated by signed records, monotonic freshness, explicit liveness evidence,
and CAS fencing. `acquireIfEligible()` remains the single authority and repeats
the verdict at actuation time, preventing a stale scheduling hint from granting
authority. The solo-renew latch is not a new takeover verdict; it records the
epoch already granted by that authority and is invalid for every other epoch.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals judgment point. The
change reuses the converged lease policy's already-enumerated hard invariants and
only alters when that authority is asked to run.

---

## 5. Interactions

- **Shadowing:** The hint calls the same `FencedLease.canAcquire` policy that
  actuation calls, so it cannot shadow a different takeover check.
- **Double-fire:** A heartbeat tick may race the pull-triggered tick, but
  `leaseTicking` is the existing process-wide reentrancy guard and only one runs.
- **Races:** Eligibility is re-evaluated inside `acquireIfEligible()` before CAS;
  a peer renewal or competing claimant between hint and actuation safely wins.
- **Feedback loops:** A successful takeover advances the epoch once. Subsequent
  pulls see self holding and do not schedule another takeover. Failed eligibility
  remains false until new evidence changes the authoritative view.
- **Solo renewal:** The epoch-bound latch permits same-epoch renewal only. A
  higher peer epoch immediately fails the equality check and fences Mini.
- **Contested resolution:** Same-epoch tie resolution runs first. The new nudge
  only follows when the post-resolution effective peer lease is actually
  takeable, preventing ordinary contention from turning into lease churn.

---

## 6. External surfaces

The visible change is timing and continuity: an eligible standby becomes awake and starts its
existing Telegram/serving path on the next roughly five-second peer pull instead
of waiting up to another two-minute heartbeat phase, then remains serving while
the peer stays offline. No API schema, persistent
record format, external credential, URL, or operator action is added. Runtime
network timing remains outside full control, but the pull cadence is bounded and
already validated to remain below the lease TTL.

No operator-facing actions are added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design with replicated authority:** the scheduling edge runs independently on every active
lease participant, using authenticated lease observations propagated by
`HttpLeaseTransport` and the existing shared/fenced epoch view. The behavior
does not create durable state of its own. The won-takeover epoch latch is
process-local because it is evidence about this incarnation's own CAS; a restart
forgets it in the conservative direction.

It emits no new user-facing notice, holds no topic-scoped durable state, and
generates no URL. One-voice behavior comes from the existing fenced lease and
poll-follows-lease path: only the CAS winner becomes awake and polls.

---

## 8. Rollback cost

Pure code rollback: revert the scheduling edge and helper, then ship the next
patch. No data migration or agent-state repair is required because no new state
is written. During rollback propagation, worst-case behavior returns to the old
timer-phase delay; fencing and split-brain safety remain unchanged.

---

## Conclusion

The review found that directly attempting acquisition on every pull would have
interfered with ordinary contested-lease resolution. The implementation was
tightened to ask the existing authority for an eligibility hint first, and
tests confirm the offline takeover, same-epoch solo renewal, and unchanged
contested path. The change is clear to ship subject to a real two-machine test.

---

## Second-pass review (if required)

**Reviewer:** `serving_takeover_review`
**Independent read of the artifact:** concur after concerns were resolved

The reviewer confirmed the takeover edge is authority-safe and convergent, and
independently reproduced the original 15/15 focused result. Three concerns were raised:

1. A blocked, unrelated decision artifact generated by the first commit attempt
   was staged. It was removed and is not part of this change.
2. This artifact was not staged and still marked review pending. It is now
   complete and staged with the change.
3. The new regression covered takeover but not clean return. Return is already
   owned by `LeaseHandbackReconciler`, not by this patch. Its claim-before-release
   and failed-handback-never-leaves-zero-holders ratchets are in
   `tests/unit/LeaseHandbackReconciler.test.ts` and
   `tests/unit/LeaseCoordinator-handbackConsent.test.ts`; those tests are
   included in the final focused gate. The requested real two-machine run will
   additionally exercise the live hand-back after both machines run this build.

After those corrections, the reviewer concurred that the staged set is scoped,
the authority boundaries remain intact, races converge safely, and the artifact
accurately distinguishes this takeover timing fix from the existing hand-back
path. The reviewer independently reproduced the expanded 150/150 focused gate
before the live test exposed the solo-renewal gap. Refreshed review of that
correction is recorded below.

The refreshed review independently reproduced the 151/151 gate and concurred
after verifying the authorization-latch invalidation sequence: takeover
authorizes epoch 2, a valid epoch 3 observation permanently clears that
authority, and removing the observation cannot resurrect epoch-2 solo holding.
No remaining blocker was found.

---

## Evidence pointers

- `tests/unit/MultiMachineCoordinator-leasePull.test.ts`
- `tests/unit/LeaseCoordinator-selfHeal.test.ts`
- Expanded takeover/solo-renewal/return result: 151 tests passed.
- Existing return-path ratchets:
  `tests/unit/LeaseHandbackReconciler.test.ts` and
  `tests/unit/LeaseCoordinator-handbackConsent.test.ts`.
- Repository lint, TypeScript compile, and production build passed.

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`,
`guardEvidence: { enforcementType: ratchet, citation:
tests/unit/MultiMachineCoordinator-leasePull.test.ts#CMT-984/CMT-992,
howCaught: the controller's edge is level-triggered by a peer takeover verdict,
re-enters the sole lease actor through its reentrancy guard, and settles after
one fenced epoch advance because self-holding makes the trigger false; the
regression ratchet proves the takeover and adjacent contested/solo cases prove
the edge does not free-run. The repository-wide
tests/unit/self-action-convergence.test.ts ratchet remains the controller-class
backstop.}`
