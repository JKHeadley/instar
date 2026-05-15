---
slug: token-burn-detection-phase-4
parent-spec: docs/specs/token-burn-detection-and-self-heal.md
review-convergence: "derived-from-umbrella"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 — umbrella approval covers this phase"
eli16-overview: docs/specs/token-burn-detection-phase-4.eli16.md
---

# Token-Burn Detection — Phase 4 Spec

**Parent**: `docs/specs/token-burn-detection-and-self-heal.md` (approved by Justin 2026-05-15).

Phase 4 of six. **First phase with blocking authority.** Introduces the Tier-2 burn-throttle runbook that consumes burn-detection signals and decides outcome (alert-only / throttle / both). The LlmRateGate upgrades from no-op to stateful — throttles install, expire, revoke.

## Scope (Phase 4)

1. **`LlmRateGate` upgrade (stateful actuator)** — install/decide/revoke/auto-expire. HMAC capability-token verification when a key is configured. Replay-prevention via consumed-signalId map. Three-layer self-loop guard (gate refuses install with self-attribution prefix; gate exempts on read; runbook refuses too).
2. **`BurnThrottleRunbook` (Tier-2 decision authority)** — handles a burn-detection DegradationEvent:
   - `alert-only-self-attribution`: never throttle the runbook itself. Per the second-pass review, emits an URGENT escalation alert instead of silent return.
   - `alert-only-config-disabled`: when `autoThrottle: false`, alert and stop.
   - `alert-only-unknown`: for `unknown::*` keys, alert but do not throttle. Operator opts in to auto-throttle on unknown via `autoThrottleOnUnknown: true`.
   - `throttle-installed`: for known keys, install bounded throttle + alert.
   - `throttle-failed`: gate refused install — surface explicitly with the "I tried but did not take effect" follow-up text.
3. **Pure helpers** — `extractAttributionKey`, `extractTrigger`, `isUnknownKey`, `composeAlertText`. Wire-shape coupling to BurnDetector's emit is documented at the helpers.
4. **22 unit tests** in `tests/unit/burn-detection-phase-4.test.ts` covering all five runbook outcomes, the gate's stateful behavior, replay-prevention, capability-token verification, ELI16 alert text shape, and the URGENT self-attribution escalation.

## Out of scope (deferred to later phases)

- **Telegram inline buttons (principal-bound + HMAC-signed).** Phase 5 upgrades the alert from plain text to interactive buttons with principal verification.
- **HMAC-signed `.instar/jobs.json.throttle-overrides` file for scheduled jobs.** The gate is in-memory only in this phase; cron-entry throttles land alongside the existing scheduler in a follow-up.
- **Wiring the runbook into DegradationReporter's subscriber chain.** This phase ships the runbook + tests; wiring the subscriber in `AgentServer` is a small constructor-order change deferred to Phase 5 (or done as a 5-line follow-up commit).
- **Verification + post-throttle follow-up Telegram.** Phase 6.

## Files touched

```
src/monitoring/LlmRateGate.ts                           (no-op → stateful + HMAC)
src/monitoring/BurnThrottleRunbook.ts                   (NEW — Tier-2 decision authority)
tests/unit/burn-detection-phase-4.test.ts               (NEW — 22 tests)
tests/unit/burn-detection-phase-1.test.ts               (1 assertion updated: phase-1-noop → no-throttle-installed)
docs/specs/token-burn-detection-phase-4.md              (this file)
docs/specs/token-burn-detection-phase-4.eli16.md        (NEW)
upgrades/side-effects/token-burn-detection-phase-4.md   (NEW)
upgrades/NEXT.md                                        (release notes)
```

## Acceptance criteria (Phase 4)

1. `installThrottle` blocks subsequent `shouldFire` calls until duration elapses.
2. Throttle auto-reverts after configured TTL.
3. `revokeThrottle` releases an active throttle (used by Phase 5 buttons).
4. Three-layer self-attribution guard fires: gate refuses install on self-prefix, runbook refuses to call install on self-prefix, gate read-path exempts self-prefix even if somehow installed.
5. Capability-token verification works when an HMAC key is configured.
6. Replay-prevention: the same signalId cannot install a throttle twice (Phase 4 second-pass review §1).
7. Self-attribution emits an URGENT escalation alert via Telegram, not silent return (Phase 4 second-pass review §3).
8. `alert-only-unknown` is the default for unknown::* keys; opt-in via `autoThrottleOnUnknown: true`.
9. `alert-only-config-disabled` is the default when `autoThrottle: false`.
10. `throttle-failed` outcome surfaces with a "did not take effect" Telegram message when the gate refuses install.

## Signal-vs-authority compliance

The runbook is the sole decision authority. The gate enforces. The detector emits. Per the umbrella spec §"Signal-vs-Authority Decomposition" table, Phase 4 fills the "burn-throttle runbook" row (Tier-2 delegated authority) and the "LlmRateGate primitive" row (mechanism). No brittle component holds blocking authority.

## Second-pass review

Required for this phase (touches blocking authority over LLM calls + the word "gate"). Conducted; concur with three concerns; all three addressed in the implementation:

1. **Replay-prevention**: `signalId` added to canonical payload + consumed-IDs map. Test exercises replay refusal.
2. **In-process mint threat model**: `computeCapabilityToken` JSDoc now states explicitly that HMAC defends the cross-process / file-tampering boundary only, and that in-process integrity depends on `/instar-dev` review discipline. Future move of the mint to a separate runbook service is sketched in the JSDoc.
3. **Silent self-attribution swallow**: replaced with URGENT escalation alert. Test updated.

Convergence report: `docs/specs/reports/token-burn-detection-and-self-heal-convergence.md`.

## Rollback

The gate's stateful upgrade is additive — old API still works. Backout = revert this PR; throttles fall back to no-op, the runbook module disappears. No persistent state, no schema change.
