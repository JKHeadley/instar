---
slug: token-burn-detection-phase-1
parent-spec: docs/specs/token-burn-detection-and-self-heal.md
review-convergence: "derived-from-umbrella"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 — approval of umbrella spec covers this phase"
eli16-overview: docs/specs/token-burn-detection-phase-1.eli16.md
---

# Token-Burn Detection — Phase 1 Spec

**Parent**: `docs/specs/token-burn-detection-and-self-heal.md` (umbrella, approved by Justin 2026-05-15 on Telegram topic 8615).

This Phase 1 spec implements the umbrella's foundation layer. The full architectural design, signal-vs-authority decomposition, and convergence audit live in the umbrella; this file documents what Phase 1 specifically ships and what it deliberately defers to later phases.

## Scope (Phase 1)

1. `attribution_key` column on `token_events` table — idempotent migration via the existing `ALTER TABLE … ADD COLUMN` swallow pattern. Index on `(attribution_key, ts)` for the burn-detector's per-key rate queries in Phase 3.
2. `TokenLedger.recordEvent({...})` write API — direct-API providers (Anthropic) explicitly record events for burn-detection observability. The CLI path continues to write JSONL which the ledger ingests via `ingestLine`.
3. `LlmRateGate` primitive at `src/monitoring/LlmRateGate.ts` — actuator with a stable shape, Phase 1 ships as a no-op. The self-attribution-exempt prefix (`burn-throttle-runbook::*`) is wired in now so future phases cannot regress on the self-reinforcing-loop guard.
4. `buildAttributionKey(component, prompt)` pure helper at `src/monitoring/attributionKey.ts`. Format `<componentName>::<promptFingerprintShort>` per umbrella spec §"Attribution key".
5. `IntelligenceOptions.attribution?: { component }` extension to the existing `IntelligenceProvider` interface. Optional so existing callers keep working unchanged.
6. `AnthropicIntelligenceProvider` wired to: (a) consult the rate gate before each call; (b) compute the attribution key from `options.attribution`; (c) record the event on the optional injected ledger.
7. `scripts/lint-no-direct-llm-http.js` — grep-based lint catching new raw-HTTP-to-LLM references in `src/`. Allowlists the two IntelligenceProvider impls; grandfathers pre-existing direct callers (`StallTriageNurse.ts`, `CoherenceReviewer.ts`, voice transcription paths) with a comment pointing at the phase that will migrate each. Wired into `npm run lint` and `scripts/pre-push-gate.js`.

## Out of scope (deferred to later phases)

- **Production wiring of the ledger into the Anthropic provider.** `AgentServer.ts:365` constructs the `TokenLedger` AFTER `selectIntelligenceProvider` runs (`server.ts:2059`). Wiring the ledger into the provider in production requires a small refactor of construction order, which Phase 1 deliberately keeps untouched. The provider's constructor accepts `deps.ledger`, tests exercise this path, and Phase 3 (BurnDetector) lands the construction-order change as part of its own wiring.
- **Tree-wide caller migration to pass `attribution: { component }` on every `evaluate()` call.** Existing callers continue to land under `unknown::<fingerprint>` fallback keys. Phase 2's `AttributionResolver` reads the JSONL telemetry for the CLI path and infers attribution from session/cwd/prompt signatures; that resolves the dominant case (most LLM calls are CLI-driven).
- **`BurnDetector`, `burn-throttle` runbook, Telegram alerting + buttons.** Phases 3–6 of the umbrella spec.
- **HMAC-signed `jobs.json.throttle-overrides`.** No throttles installed yet, so no override file. Phase 4.

## Files touched

```
src/core/types.ts                                   (IntelligenceOptions.attribution added)
src/core/AnthropicIntelligenceProvider.ts           (rate gate + attribution + ledger write)
src/monitoring/TokenLedger.ts                       (attribution_key column + recordEvent API)
src/monitoring/LlmRateGate.ts                       (NEW — no-op actuator primitive)
src/monitoring/attributionKey.ts                    (NEW — pure helper)
scripts/lint-no-direct-llm-http.js                  (NEW — grep lint)
scripts/pre-push-gate.js                            (wire the new lint into pre-push)
package.json                                        (npm run lint composition)
tests/unit/burn-detection-phase-1.test.ts           (NEW — 21 tests)
docs/specs/token-burn-detection-and-self-heal.md    (umbrella, brought from sibling worktree)
docs/specs/token-burn-detection-and-self-heal.eli16.md
docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
docs/specs/token-burn-detection-phase-1.md          (this file)
docs/specs/token-burn-detection-phase-1.eli16.md    (NEW — Phase 1 ELI16)
upgrades/side-effects/token-burn-detection-phase-1.md (NEW)
upgrades/NEXT.md                                    (release notes)
```

## Acceptance criteria (Phase 1)

1. `attribution_key TEXT NOT NULL DEFAULT 'unknown::pre-attribution'` exists on `token_events` after init.
2. Re-opening an existing DB does NOT throw on the migration ALTER TABLE (idempotent — covered by test).
3. `recordEvent` is idempotent on `request_id` (covered by test).
4. `LlmRateGate.shouldFire` returns true for every key in Phase 1 (covered by test).
5. `burn-throttle-runbook::*` prefix is structurally exempt at the gate (covered by test).
6. `AnthropicIntelligenceProvider.evaluate` records events with the composed attribution_key when a ledger is injected (covered by test).
7. A ledger write failure does NOT break the LLM result return (covered by test).
8. `npm run lint` exits 0 on the current tree (no false positives on grandfathered files).
9. A synthetic new file containing `api.anthropic.com` is rejected (covered by test).
10. Pre-push gate runs the new lint (covered by inspecting `scripts/pre-push-gate.js`).

## Rollback

All Phase 1 deltas are additive. Backout path per file:
- Remove the new `LlmRateGate` / `attributionKey` modules → no callers depend on them outside the Phase 1 wiring.
- Revert the `AnthropicIntelligenceProvider` constructor extension → deps is optional so old call sites are unaffected.
- Revert the `IntelligenceOptions.attribution` extension → optional field, dropping it is non-breaking.
- The `attribution_key` column survives revert and is harmless if nothing reads it.
