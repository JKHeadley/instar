# Side-Effects Review — Stall Sentinel Recovery

**Version / slug:** `stall-sentinel-recovery`
**Date:** `2026-08-26`
**Author:** `echo`
**Second-pass reviewer:** `stall_recovery_review`

## Summary of the change

This change repairs two linked autonomous-liveness failures. `AutonomousThroughputFloor` now reports typed eligibility reasons and accepts durable local ownership even when the registry contains other machines. `AutonomousLivenessReconciler` now treats a positively idle live Codex session as a completed turn and uses the canonical fresh `SessionRefresh` path to continue it. Server wiring supplies ownership and idle-session evidence; templates and `PostUpdateMigrator` carry awareness to new and existing agents. A related cross-model-review fallback is confined to its package tree so unrelated repositories cannot inherit this checkout's agent config.

## Decision-point inventory

- `AutonomousThroughputFloor.ineligibilityReason` — modify — separates enumerable validity, channel, ownership, and move-state boundaries.
- `AutonomousLivenessReconciler.tick` — modify — routes a positively idle live session through the same eligibility and safety floors as an absent session before refresh.
- `server.ts` liveness wiring — modify — supplies positive-idle evidence and delegates actuation to canonical `SessionRefresh`.
- `cross-model-review.mjs` config fallback — modify — confines a compatibility fallback to callers inside the package tree.

---

## 1. Over-block

An ownership-unknown run remains refused when more than one machine is registered, even if all other registrations are stale. This is intentional fail-closed behavior: only a durable `local-active` record proves this machine may judge or revive the run. A live session that is not positively idle is not refreshed. A caller outside `ROOT` no longer receives the legacy package-root config; it must use cwd walk-up, `--config`, or `INSTAR_CONFIG_PATH`.

---

## 2. Under-block

Incorrect durable ownership data could still authorize the wrong machine; this change consumes the ownership registry rather than redefining its authority. Prompt classification can miss a future Codex idle-screen shape until `SessionReaper.isPositivelyIdle` learns it. A process can change state between observation and actuation, so the reconciler rechecks the same session under the claim immediately before refresh. Refresh failure is bounded, audited, and escalated rather than retried without limit.

---

## 3. Level-of-abstraction fit

The change reuses the existing ownership registry as authority, `SessionReaper.isPositivelyIdle` as the shared detector, the liveness reconciler as the existing gated recovery controller, and `SessionRefresh` as the canonical lifecycle actuator. It does not add a competing tmux nudge or a parallel session-spawn mechanism.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the positive-idle detector produces a signal consumed by the existing gated liveness authority.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The terminal classifier never actuates directly. The reconciler combines it with durable run validity, Telegram scope, ownership, move state, lease, stop, quota, pressure, concurrency, debounce, failure budget, and an actuation-time recheck. The eligibility reasons are enumerable structural invariants, not semantic message judgments.

---

## 4b. Judgment-point check

No new static heuristic decides among competing live signals. Positive-idle classification is an observation fed into the existing floor-based controller. Durable ownership and run validity are enumerable invariants. The controller retains all existing floors and does not introduce a new priority policy.

---

## 5. Interactions

- **Shadowing:** active non-idle sessions still take the existing healthy path. Idle sessions enter recovery only after the same debounce and safety gates used for missing sessions.
- **Double-fire:** the topic claim plus actuation-time idle/session-name equality check prevents concurrent ticks from refreshing the same observed turn twice.
- **Races:** a session becoming busy after the snapshot is caught by the second `idleTopicSnapshot` check; ownership and stop state are also re-read before actuation through existing gates.
- **Feedback loops:** successful refresh makes the old idle session disappear or cease being positively idle. Failures consume the existing bounded failure budget and raise one aggregated escalation.
- **Config resolution:** explicit and environment config rungs still win; cwd walk-up is unchanged; only unrelated use of the package-root compatibility fallback is removed.

---

## 6. External surfaces

Existing agents gain typed status/audit conditions and can observe a canonical fresh session replacement when an autonomous Codex turn completes. No new operator action, credential, URL, external API, or persistent schema is introduced. Telegram notification uses the existing liveness notification path and existing one-voice ownership gates. Timing depends on the configured reconciler cadence and debounce.

---

## 6b. Operator-surface quality

No dashboard renderer, approval page, grant/revoke form, or other operator surface is changed. Not applicable.

---

## 7. Multi-machine posture

**Machine-local by design, governed by replicated ownership.** Terminal state and tmux sessions are machine-local physical truths. The decision to act is authorized by the durable topic ownership registry and the existing lease/move gates. A remote-owned run is explicitly refused; an unknown owner is accepted only in a genuinely single-machine registry. User-facing notices use the existing owner-gated notification path. The change adds no durable state that can strand on transfer and generates no URLs.

---

## 8. Rollback cost

Rollback is a hot-fix revert and patch release. No schema or user-data migration is required. Existing audit rows remain readable. During rollback propagation, completed turns return to the old non-revivable behavior and typed reasons collapse, but no stored state needs repair.

---

## Conclusion

The recovery is placed at the existing lifecycle-controller layer, consumes shared detectors and authorities, preserves all safety floors, and adds bounded escalation. The isolation fix removes unintended ambient configuration without altering explicit or normal walk-up resolution. The independent review found a multi-machine TOCTOU gap between the initial ownership check and destructive refresh; the implementation now re-reads ownership, lease, move/run eligibility, operator stop, queue custody, and the exact idle session under the claim, with a race regression test. The change is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** `stall_recovery_review`
**Independent read of the artifact:** Concur with the review

The reviewer found that the first implementation rechecked only the idle session under the process-local claim, leaving ownership transfer able to race with destructive refresh. The code and artifact were corrected to revalidate every lifecycle authority at the actuation instant, and a regression test moves ownership immediately after claim acquisition and proves refresh is refused.

Concurrence: the claimed session, current run generation/state, ownership, lease, operator-stop, and queue custody are now revalidated fail-closed under the claim; the regression demonstrates refresh suppression and claim release, closing the material lifecycle race.

---

## Evidence pointers

- `tests/unit/AutonomousThroughputFloor.test.ts`
- `tests/unit/AutonomousLivenessReconciler.test.ts`
- `tests/integration/autonomous-liveness-routes.test.ts`
- `tests/e2e/autonomous-liveness-reconciler-lifecycle.test.ts`
- Final affected gate: 91/91 tests; full repository gate: 50,085 tests exercised, all discovered failures repaired and rerun.

---

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the controller edge is gated by a per-topic claim and actuation-time idle recheck; success settles by replacing the completed session, while failure consumes a bounded retry budget and escalates, so the same idle turn cannot drive an unbounded refresh loop }`.
