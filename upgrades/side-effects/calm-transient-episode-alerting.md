# Side-Effects Review — Calm Transient-Episode Alerting (build)

**Version / slug:** `calm-transient-episode-alerting`
**Date:** `2026-07-12`
**Author:** `echo`
**Second-pass reviewer:** `the converged spec IS the second pass — 4 rounds, 7 reviewers/round incl. cross-model, 24 material findings resolved (docs/specs/reports/calm-transient-episode-alerting-convergence.md); build follows the approved spec exactly`

## Summary of the change

Implements the converged + operator-approved `docs/specs/calm-transient-episode-alerting.md`. Files: `machineCoherenceAnchors.ts` (NEW — M-P0 durable identity-independent clocks), `machineCoherenceEpisode.ts` (additive fields: anchors block, derivedItemIds, operatorInteracted, calmClass, resolveNoteAtByItem), `machineCoherenceEpisodeManager.ts` (anchors reconcile, calm classification/copy/priority/silence, derived escalations, resolve bounding, orphan self-closeout, wave backstop, evidence-carrying ack), `MachineCoherenceSentinel.ts` (config keys + M-P1 anchor-based confirmation + calm counters), `machineCoherenceEffectsExecutor.ts` (NEW — the extracted pass-through consumer), `ropeSinkRouter.ts` (NEW — M-P3 typed-class routing + delivery-true demotion + both-class dedupe), `RopeRecoveryProber.ts` (typed class + peer/kind on the escalate payload), `RopeHealthMonitor.ts` (recovering-rope digest class), `TelegramAdapter.ts` (silent item posts + silent status option), `server.ts` (executor shim, sink router wiring, sanity warning), `templates.ts` + `PostUpdateMigrator.ts` (doc parity: content-update + new-row-kind migrations + embedded-copy update).

## Decision-point inventory

All five decision points are the spec's `invariant`-classified rows, implemented exactly: confirmation timing (durable anchors), priority/copy/notification mapping, resolve-note mode, rope routing (typed class + live conjunction), escalation issuance (durable latches, cap-exempt). Each was contested and upheld through 4 convergence rounds. The master gate `calmEnabled` rides resolveDevAgentGate; DARK ⇒ bit-identical legacy behavior including zero durable-file changes (regression suites pass under explicit `calmEnabled: false`).

## 1. Over-block

No block/allow surface. Suppression risk (silencing too much) is bounded by design: every predicate failure falls toward LOUDER (no-anchor ⇒ legacy grace; unreadable versions ⇒ no-advance ⇒ confirm; undeclared rope class ⇒ actionable ⇒ hub; digest conjunction miss ⇒ hub fallback), and the loud arms stand on durable anchors that identity churn / restarts / peer dips can no longer reset.

## 2. Under-block

The calm class is narrow by construction: ONLY patch-only version skew (every other dimension keeps today's loud raise); a calm episode already past the ceiling at open raises loud directly; the flap brake + wave backstop + 3h ceiling + 24h escalation append bound sustained quiet.

## 3. Level-of-abstraction fit

Per the converged spec: decisions live in the episode manager (context-rich), the executor and sink are pass-throughs, the anchors are a pure module, the digest class lives in the monitor that composes digests. The prober stays a scheduling layer (its escalate DECLARES class; it routes nothing).

## 4. Signal vs authority compliance

The guard remains pure signal — nothing blocks, equalizes, or restarts. The M-P3 router's suppression authority is a deterministic closed-enum check on a SOURCE-DECLARED typed field (the documented exemption class), replacing the id-prefix parse the round-1 conformance gate flagged.

## 5. Interactions

- Reopen latch vs flap brake: complementary (noise vs escalation), thresholds independent, latched-wins-toward-silence precedence implemented at close.
- Per-day cap vs derived raises: derived ids are cap-EXEMPT (each ≤1/key/24h by durable latch — the load-bearing-coincidence hole closed).
- createAttentionItem id-dedupe: the intended idempotency for derived raises; the reopen path no longer relies on it (append conversion — the silent-swallow fix, gated).
- M6 suppression: anchors consume POST-suppression rows; suppression suspends (never retires) flag anchors.

## 6. External surfaces

Operator-visible alert semantics change ONLY under the dev-agate (LIVE on the requesting operator's machines, DARK fleet-wide): calm episodes silent, self-heal resolves quiet, escalations loud with prompts, rope informational content demoted only where the digest provably delivers. No new API routes; `/pool/machine-coherence` gains the calm counters block (additive).

## 6b. Operator-surface quality

The changed surface is the alert stream itself: calm copy leads with the observed state in plain words and carries NO decision prompt (the round-1 contradictory-UX fix); loud raises keep the impact-first fix-it/leave-it flow; rope notices name machines by nickname with direction labels; withdrawal notes adapt to the close reason. Zero raw internals in any new message body.

## 7. Multi-machine posture (Cross-Machine Coherence)

Per the spec's converged section: unified via every-machine anchor computation from shared adverts + per-machine durable persistence (new FIELDS in the existing episode file, `version: 1`, additive, rollback-inert); notes are item-holder voice (≤2×-per-handoff residual disclosed); orphan self-closeout resolves each machine's OWN items on every close reason regardless of speaks(); rope health stays machine-local BY DESIGN with the live deliverability check making demotion pool-safe. No new machine-local surface.

## 8. Rollback cost

Config-only: `calmEnabled: false` (master, bit-identical legacy), or per-mechanism levers (`progressExtensionEnabled`, `flapBrakeEnabled`, `calmRaiseNotify: true`, `patchSkewPriority: 'HIGH'`, `silentResolveNote: false`, `slowAliveToDigest` n/a — sink falls back to hub when the conjunction fails, `calmWaveBackstopEnabled: false`). No migration; anchor fields inert when dark.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure: guard.** The change modifies self-triggered notification paths and BOUNDS them structurally: per-key 24 h durable derived-raise latches (restart-proof), per-episode derivedItemIds once-per-class records, resolve-note bounding (one per item per reopenWindowMs; latched-flapping ⇒ jsonl only), wave-notice 24 h dedupe, flap-history 64-event clamp, the existing per-day cap + append budget retained, and the fail-loud `escalationRaiseFailed` invariant. Convergence proven by `tests/unit/machine-coherence-anchors.test.ts` (latch/clamp/dedupe arithmetic) + `tests/unit/machine-coherence-calm-narration.test.ts` (once-per-episode derived raises, bounded resolves, single wave fire) + `tests/unit/rope-sink-router.test.ts` (both-class 24 h dedupe). Every emission settles to a bounded steady state under sustained pressure.
