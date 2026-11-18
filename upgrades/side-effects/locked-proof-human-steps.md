# Side-effects review: locked-Mac proof human sequencing

2026-11-17. Echo. Tier1 reversible, harness-only. Two implementation files, targeted timeline tests, small existing fake-target correction, ELI16 and release artifacts. Parent and independent second review complete. No commit/push/live desktop actions by implementer.

## Problem and chosen behavior

Cases12.12/13 can finish against incomplete human actions or a stale pre-logout observation.12.13 never stopped the grant before waiting for watching, so the normal grant expiry exceeded its case deadline.15.10/11 cue after sleeping but tell the human to wait again. The harness now records explicit console sequencing, starts the relock watch before logout, proves recorded producer exit, and sends an immediate cue from the observed watch start.

## 1. Over-block

Missing console identity, unknown process observations, absent producer identity, missing watch start, early return, or an unlock on the wrong side of the watch fail proof. Temporary unobservability can therefore require repeating a human case. It never blocks product remote access. No-lock-call measurement remains absent and fails12.12/13, even with a completed human sequence.

## 2. Under-block

A sticky console event or pre-action snapshot no longer proves return. Logout requires valid identities for every recorded guard and any present typist before bootout, positive departure that is still observed before the login cue, and old recorded producer exit by PID/start; unknown ps output throws. Unknown readings reset incomplete switch dwell evidence; an already completed thirty-second dwell remains recorded through loginwindow/unknown transit before the fresh return. Delayed unlock must follow the cue on the expected side of the native two-minute watch. Polling samples observations rather than claiming continuous surveillance; no claim about hidden between-sample transitions is made.

## 3. Layer fit

Changes stay in the existing proof driver and verdict. Human cues and observed transitions are harness responsibilities. The native no-lock-call observation gap is not filled with inferred zero or a source-text assertion.

## 4. Signal versus authority

Closed test-case enums and measured timestamps determine proof outcomes, not user-message routing or product authorization. Deterministic evidence checks are appropriate here under docs/signal-vs-authority.md.

## 5. Interactions and failure paths

The12.13 stop-viewer action allows the native watch to begin before logout. Departure and producer-exit checks are bounded to30seconds; failure runs normal recovery and prevents the login cue. New snapshots follow injections/cues. The other cases retain their existing injection loop; no product controller or native helper changes. A missing measurement remains a failed result, not success from absence.

## 6. External surfaces

Only messages during an explicitly executed proof run change: delayed checks say to unlock now rather than promising a later cue that never arrives. Evidence gains console-owner/timing fields; it contains no password. No live notifications, account switch, logout, lock or unlock occurred during this implementation.

## 6b. Operator surface

The cue names the immediate action at its execution time. The runner waits for observable completion instead of treating a message as an action. Human scheduling remains with the proof owner.

## 7. Multi-machine posture

Proof-machine local. No replicated state, remote API, fleet install/restart, TCC or native binary changes. Source-control delivery updates the harness. The supplied native build remains unchanged.

## 8. Rollback

Revert the harness/test commit between proof runs. No persistent fixture or configuration is introduced and no migration is needed. Do not revert mid-human sequence; stop/recover that proof first.

## Validation

Targeted timeline regressions exercise successful and incomplete console round trips, dwell interruptions, missing logout evidence, watch timing, pre-cue unlocks, late unlocks and absent watch starts. Driver action tests cover no departure, a surviving producer, unreadable owner and ordered departure/exit. Existing tests receive a watchStart in their fake native marker. Full verification belongs to Local Verify before merge; independent second review concurs after early-return and incomplete-producer fixes. No real-Mac proof claimed.

## Class closure

No prompt/config/hook/skill defect or self-triggered production controller. Not applicable. New regressions cover the observed stale-evidence and incorrectly timed human-cue defects.

Final validation: parent independently ran113/113 targeted tests including proof build checks. Author timeline+driver run102/102 passed. Independent reviewer verified early-return rejection, mandatory actor identity and completed-dwell preservation. No live proof, no inferred lockCalls zero. Fast guards and normal commit/push hooks are recorded with the PR; full verification belongs to Local Verify.
