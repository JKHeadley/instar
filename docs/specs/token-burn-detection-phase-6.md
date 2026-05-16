---
slug: token-burn-detection-phase-6
parent-spec: docs/specs/token-burn-detection-and-self-heal.md
review-convergence: "derived-from-umbrella"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 — umbrella approval covers this phase"
---

# Token-Burn Detection — Phase 6 Spec

**Parent**: `docs/specs/token-burn-detection-and-self-heal.md` (approved by Justin 2026-05-15).

Phase 6 of six (final). Closes the loop on the burn-detection auto-heal pipeline: verification + post-throttle follow-up, plus the AgentServer wiring that makes the previous five phases fire on live burns.

## Scope (Phase 6)

1. **`BurnVerifier`** — schedules a re-sample 5 minutes after a throttle install. Re-reads the token ledger for the affected attribution_key, computes the rate ratio, and emits one of two structured follow-up Telegram messages:
   - **Caught and contained**: post-throttle rate below configured `successRatio` (default 0.5) of pre-throttle. Reports before/after numbers in the umbrella spec's "fixed, here's the before/after" shape.
   - **Did not take effect**: rate did not drop. Escalates explicitly with two-cause explanation (attribution mismatch, or path doesn't honor the gate).

2. **AgentServer wiring** — instantiates the six-phase pipeline at server startup, after the TokenLedger comes up:
   - `BurnThrottleRunbook` with the LlmRateGate singleton + the TelegramAdapter's `sendToTopic` as the alert sender.
   - `BurnVerifier` with the same ledger + telegram sender.
   - `registerBurnDetectionSubscriber(reporter, runbook, (out, ev) => verifier.scheduleVerification(out, ev))` — wires the runbook into DegradationReporter's healer surface AND passes outcomes to the verifier for re-sampling.
   - `BurnDetector` with the ledger + reporter, `.start()` begins the 60s polling loop.
   - Shutdown path: stops the detector before the ledger closes, drops runbook + verifier refs so any pending timers no-op.

3. **9 unit tests** for the verifier + integration with the runbook outcome surface.

## Files touched

```
src/monitoring/BurnVerifier.ts                          (NEW)
src/server/AgentServer.ts                               (imports + private fields + start() wiring + stop() shutdown)
tests/unit/burn-detection-phase-6.test.ts               (NEW — 9 tests)
docs/specs/token-burn-detection-phase-6.md              (this file)
docs/specs/token-burn-detection-phase-6.eli16.md        (NEW)
upgrades/side-effects/token-burn-detection-phase-6.md   (NEW)
upgrades/NEXT.md                                        (release notes)
```

## Acceptance criteria

1. After a throttle install, the verifier schedules a re-sample at 5min.
2. On successful drop, sends caught-and-contained before/after message.
3. On no drop, sends did-not-take-effect escalation.
4. Non-throttle outcomes do not schedule verification.
5. Pre-throttle rate is correctly extracted from both BurnDetector emit shapes.
6. Configurable success ratio works.
7. AgentServer wires the pipeline at startup AND shuts it down cleanly on stop.
8. Server starts cleanly with the new wiring (tsc + existing tests green).

## Signal-vs-authority compliance

The verifier emits structured Telegram messages — it does not decide, throttle, or block. The AgentServer wiring instantiates already-decided actors; no new decision surface is introduced. **Compliant.**

## Second-pass review

Required for this phase per `/instar-dev` Phase 5 criteria — touches outbound messaging + the AgentServer lifecycle (session-adjacent). Conducted; concur (the verifier is pure observation + structured Telegram, the wiring instantiates the existing audited actors, no new authority surface).

## Rollback

Additive. Backout = delete `BurnVerifier.ts`, the test file, and revert the AgentServer changes (wiring block + shutdown block + imports + private fields). No persistent state, no schema change. The detector + runbook can be re-disabled at runtime via the existing `tokenBurnDetection.enabled: false` config flag (no code change required).
