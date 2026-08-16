# Side-Effects Review — Token-Burn Detection Phase 2

**Spec**: `docs/specs/token-burn-detection-phase-2.md` (parent: `docs/specs/token-burn-detection-and-self-heal.md`, approved by Justin 2026-05-15).

## 1. Over-block

Phase 2 cannot block anything — it's a pure function with no caller in production yet. Worst case "over-block" is a wrong attribution: a prompt that should have been labeled `InputDetector` ends up under `unknown::<sessionPrefix>`. Phase 3's detector treats unknown-keyed spend as alert-only-on-unknown (per umbrella §"Auto-throttle mechanism"), so even a wrong attribution still produces a usable alert — just less informative.

## 2. Under-block

The pattern manifest covers nine known instar-internal components. New components added in unrelated PRs do not appear in the manifest until someone adds them. They fall through to `unknown::<sessionPrefix>` and are still observable — just not labeled by name. Adding manifest entries is the right discipline going forward; the lint from Phase 1 catches new direct-LLM-HTTP callers, but it does not catch new components calling through the chokepoint without a manifest entry. This is a known and accepted gap.

## 3. Level-of-abstraction fit

`AttributionResolver` and the manifest sit in `src/monitoring/`, next to `TokenLedger` and `LlmRateGate`. Correct layer: it's part of the observability surface, not a piece of the core LLM-call path or a decision-maker.

The resolver is a pure function — no I/O, no time-dependent behavior. That's the right abstraction; Phase 3's read path can call it in a tight loop without worrying about side effects.

## 4. Signal-vs-authority compliance

The resolver is signal-only. It produces an attribution key; it does not decide whether anything happens. The umbrella spec's §"Signal-vs-Authority Decomposition" places AttributionResolver in the "no authority" row, and Phase 2 matches that placement.

**Compliant.**

## 5. Interactions

- **TokenLedger.** No interaction in Phase 2 — the resolver does not read or write the ledger. Phase 3 will pair them.
- **LlmRateGate.** No interaction. The gate enforces decisions; the resolver produces keys those decisions reference.
- **AnthropicIntelligenceProvider chokepoint path.** No interaction — when the chokepoint writes attribution_key, Phase 3's read path passes it through unchanged and skips the resolver call.
- **Other manifests.** No other manifest in the tree has overlapping responsibility; this is a new file.

No shadowing, no double-fire, no race.

## 6. External surfaces

No external surface change. Phase 2 is internal pure code with no callers in production.

## 7. Rollback cost

Three new files (`AttributionResolver.ts`, `attribution-manifest.ts`, test). Backout = delete the three files. No persistent state, no schema change, no caller dependency until Phase 3.

## Second-pass review

Phase 2 ships pure observability inference with no runtime decision authority. It does NOT touch any of the high-risk surfaces listed in `/instar-dev` Phase 5 (no block/allow, no session lifecycle, no coherence gate, no sentinel/guard/gate/watchdog with authority). Second-pass review is **not required** per the skill's criteria.
