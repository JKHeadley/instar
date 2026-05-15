---
slug: token-burn-detection-phase-3
parent-spec: docs/specs/token-burn-detection-and-self-heal.md
review-convergence: "derived-from-umbrella"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 — umbrella approval covers this phase"
eli16-overview: docs/specs/token-burn-detection-phase-3.eli16.md
---

# Token-Burn Detection — Phase 3 Spec

**Parent**: `docs/specs/token-burn-detection-and-self-heal.md` (approved by Justin 2026-05-15).

Phase 3 of six. **First user-observable phase**: the detector emits to the existing `DegradationReporter`, which is dashboard-visible. No alerts to Telegram yet (Phase 5), no auto-throttling (Phase 4), no Remediator routing yet (Phase 4).

## Scope (Phase 3)

1. `src/monitoring/BurnDetector.ts` — the detector class:
   - 60-second polling loop, decoupled from the ledger writer cadence.
   - Two triggers: absolute-share (single key > 25% of 24h total) OR baseline-divergence (1h rate > 2x trailing-7d median AND > 10M tok/h floor).
   - **Cold-start**: baseline-divergence trigger held off until a key has been observed for 7 days. Absolute-share fires from day one — that is the trigger that would have caught the 2026-05-15 incident.
   - Per-key 1h alert cooldown (default).
   - `burn-throttle-runbook::*` prefix exempt at the detector level (defence-in-depth; Phase 1 also exempts at the rate-gate).
   - Disabled by config flag → emits nothing.
   - Injectable clock for tests.

2. `TokenLedger.byAttributionKey({ sinceMs, limit })` — new query API. Per-key aggregation over the configurable window. Indexed by the Phase-1 `(attribution_key, ts)` index for cheap polling.

3. `DegradationReporter` emit on threshold cross — `feature: 'token-burn-detection'`, the legacy quintuple. Routes through the existing Remediator dispatch as a normalized degradation event. Phase 4's runbook will subscribe via the dispatcher.

4. 16 unit tests in `tests/unit/burn-detection-phase-3.test.ts`.

## Out of scope (deferred to later phases)

- **Wiring the detector into `AgentServer` startup.** This phase ships the class + the query. The construction order refactor (so the detector can hold the ledger reference) lands in this PR if straightforward — otherwise Phase 4 adopts it. (Implementation note: this Phase 3 PR keeps `AgentServer` untouched. The detector is unit-testable end-to-end; integration into the running server happens in Phase 4 when the Tier-2 runbook also needs to register with the Remediator.)
- **Phase-4 runbook subscription via Remediator dispatch.** The detector emits today via `DegradationReporter.report()`, which already feeds the Remediator's F-1/F-8 dispatch — so the wiring is structurally in place; the consumer just doesn't exist yet.
- **Telegram alerts with principal-bound buttons.** Phase 5.
- **Auto-throttle via the `LlmRateGate` actuator.** Phase 4.

## Files touched

```
src/monitoring/BurnDetector.ts                          (NEW)
src/monitoring/TokenLedger.ts                           (+byAttributionKey query, +AttributionKeyRow type)
tests/unit/burn-detection-phase-3.test.ts               (NEW — 16 tests)
docs/specs/token-burn-detection-phase-3.md              (this file)
docs/specs/token-burn-detection-phase-3.eli16.md        (NEW — Phase 3 ELI16)
upgrades/side-effects/token-burn-detection-phase-3.md   (NEW)
upgrades/NEXT.md                                        (release notes)
```

## Acceptance criteria (Phase 3)

1. Absolute-share trigger fires when a single key > 25% of 24h total.
2. Baseline-divergence trigger fires when 1h rate > 2x trailing-7d median AND > 10M tok/h floor AND past cold-start window.
3. Cold-start handling: baseline-divergence does NOT fire within 7 days; absolute-share STILL fires from day 1 (the 2026-05-15 case).
4. Per-key cooldown of 1h between repeat signals for the same key.
5. `burn-throttle-runbook::*` prefix is exempt at the detector level.
6. `enabled: false` config silences the detector.
7. Empty ledger emits nothing (no division-by-zero).
8. `start()` / `stop()` are idempotent.
9. `TokenLedger.byAttributionKey` returns per-key aggregations.
10. `DegradationReporter` receives `feature: 'token-burn-detection'` on emit.

## Signal-vs-authority compliance

Detector is signal-only. Emits to `DegradationReporter`, which routes through the existing Remediator dispatch. The Phase 4 runbook (Tier-2 surface with signed context + audit + lock + deadline) is the only blocking authority. Phase 3 does not gate, throttle, or decide anything.

## Rollback

Phase 3 adds two new modules (`BurnDetector`, the test file) and one new query method on `TokenLedger`. Revert = delete the files + drop the method. The query method's index was added in Phase 1's migration — surviving the revert is harmless.
