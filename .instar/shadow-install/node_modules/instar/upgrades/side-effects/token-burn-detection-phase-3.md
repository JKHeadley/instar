# Side-Effects Review — Token-Burn Detection Phase 3

**Spec**: `docs/specs/token-burn-detection-phase-3.md` (parent: `docs/specs/token-burn-detection-and-self-heal.md`, approved by Justin 2026-05-15).

## 1. Over-block

Phase 3 cannot over-block — it does not block anything. It only emits a degradation event when a key crosses one of the two thresholds. The emit is consumed by the existing Remediator dispatch (Phase 4 will subscribe a runbook).

The signal-emit itself could be excessive: a legitimate sustained burst (e.g. a long debugging session genuinely needing the LLM) would generate a single signal followed by a 1h cooldown. The dashboard's degradation tab would show "this component is using a lot of tokens" — informational, not blocking. Phase 4 will gate that signal into action (alert / throttle / both).

## 2. Under-block

The detector observes whatever the ledger has. Two known gaps:

1. **Raw-HTTP bypass paths** (already grandfathered out of the Phase-1 lint) — `StallTriageNurse`, `CoherenceReviewer`, and the voice-transcription routes. They write to the Anthropic API directly today; the chokepoint does not capture them; the ledger does not see them; the detector cannot react to them. This is the same gap the umbrella spec acknowledged in its convergence-report §"Original vs Converged" point 7. Phase migration of these callers is tracked in the Phase-1 lint grandfather list.

2. **Cold-start blind spot to baseline-divergence**. Within the first 7 days, a slow-burn pattern that crosses 2x baseline but not 25% absolute will go unflagged. The umbrella spec accepts this as a known limitation; on a brand-new agent the absolute-share trigger is the floor of protection.

## 3. Level-of-abstraction fit

`BurnDetector` lives in `src/monitoring/` next to the `TokenLedger` and `LlmRateGate`. Correct layer: it consumes observability data and emits a degradation signal — the same shape every other detector in monitoring uses.

The query method `byAttributionKey` is a small extension of the existing `TokenLedger` API. Same SQLite handle, same idempotent behavior. Correct layer.

## 4. Signal-vs-authority compliance

The detector is signal-only — it cannot decide, throttle, or block anything. It emits to `DegradationReporter.report()`, which routes through the existing F-1/F-8 Remediator dispatch. The Phase 4 runbook is the only authority that consumes the signal and decides outcome.

Per the umbrella spec's §"Signal-vs-Authority Decomposition" table, `BurnDetector` is in the "No authority" row. This phase's implementation matches that placement.

**Compliant.**

## 5. Interactions

- **TokenLedger.** `byAttributionKey` is a new read-only query. No write-path interaction. Phase 1's index on `(attribution_key, ts)` keeps the polling cheap.
- **DegradationReporter.** Uses the existing public `report({...})` method. No new method on the reporter; no new event-shape; same legacy-quintuple that today's emit sites use.
- **Remediator dispatch.** `DegradationReporter.report` already feeds the Remediator (F-1/F-8) per Phase 2 of the Remediator V2 spec. Phase 3 does not need to subscribe; Phase 4's runbook will.
- **AttributionResolver (Phase 2).** Not yet wired here. The detector reads attribution_key as written today; legacy events land under `unknown::pre-attribution` until Phase 4 wires the resolver into the ledger ingest path. The detector's `unknown::pre-attribution` results will still trigger the absolute-share threshold if they dominate spend (which they will on agents migrating from pre-Phase-1).
- **LlmRateGate (Phase 1).** No direct interaction in this phase — the gate enforces decisions, and the detector does not make decisions.

No double-fire, no race, no shadowing.

## 6. External surfaces

- **DegradationReporter persistence.** A new feature label, `token-burn-detection`, will appear in the persistence file. Dashboard reads this file and groups by feature; new label simply shows up.
- **Dashboard.** Inherits the degradation row. No new tab, no new UI component.
- **No new endpoints, no new commands.**

## 7. Rollback cost

Three changes: a new module (`BurnDetector.ts`), a new query method on `TokenLedger`, a new test file. Revert = delete the two new files + drop the method. No persistent state, no schema change required (the column added in Phase 1 stays).

Disabling at runtime is one config flag: `tokenBurnDetection.enabled: false`. Default is on.

## Second-pass review

Phase 3 ships a signal-only detector with no runtime decision authority. It does NOT touch any of the high-risk surfaces listed in `/instar-dev` Phase 5 (no block/allow on messaging, no session lifecycle change, no coherence gate, no sentinel/guard with blocking authority). It emits to an existing degradation channel that already has its own audit + routing surface.

Second-pass review is **not required** per the skill's criteria. Phase 4 (the Tier-2 runbook with blocking authority over LLM calls) WILL require second-pass review.
