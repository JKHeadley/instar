# Side-Effects Review — Codex model-retirement fallback

**Version / slug:** `codex-model-retirement-fallback`
**Date:** 2026-07-10
**Author:** Instar-codey
**Second-pass reviewer:** not required

## Summary of the change

`eventNormalizer.ts` now emits the existing `unsupported` error kind for Codex's exact ChatGPT-account model-retirement response. `CodexCliIntelligenceProvider` consumes that classified signal and retries once using the explicit `gpt-5.4-mini` safe-floor constant, after verifying it remains in `KNOWN_CODEX_MODEL_IDS`. Both structured and legacy exec modes use the same bounded authority.

## Decision-point inventory

- Codex upstream-error classification — modify — distinguish the model-retirement response from generic authentication errors.
- Internal Codex retry authority — add — permit one safe-floor retry only for the classified retirement signal.

## 1. Over-block

No legitimate request is blocked. A successful first attempt is unchanged. Failures outside the exact retirement signature continue surfacing exactly as before. A caller already using the fallback floor is never retried, preventing a same-model duplicate call.

## 2. Under-block

If OpenAI changes the retirement wording, the new response will surface rather than trigger recovery; this is deliberately fail-loud. The fallback model can itself be retired, in which case its error surfaces after the single retry. API-key-only model availability is not inferred from generic errors.

## 3. Level-of-abstraction fit

The event normalizer owns provider-native error classification. The intelligence provider owns bounded execution recovery and already controls both spawn modes. The retry consumes the shared classified signal rather than creating a second raw-stderr policy. The known-model registry remains the authority for acceptable Codex model identities.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the brittle provider-signature detector produces the structured `unsupported` signal; the provider's narrowly enumerated recovery policy consumes it.

This is also a constrained protocol invariant, not conversational judgment. The detector cannot retry anything itself. The authority requires the exact classified condition, a different requested model, and a known registry member before acting.

## 5. Interactions

- **Shadowing:** retirement classification runs before generic auth classification so the recoverable condition is no longer swallowed by the broader category.
- **Double-fire:** `evaluate()` owns the only retry. The mode-specific execution methods do not recurse and do not contain fallback logic.
- **Races:** there is no shared mutable retry state; the attempt bound is lexical to one evaluation.
- **Feedback loops:** the fallback invocation bypasses the outer catch, so a second retirement response surfaces instead of feeding back into another retry.
- **Observability:** `onModel` receives the original model and then the fallback model. Existing usage callbacks still reflect any structured usage that Codex emitted per attempt.

## 6. External surfaces

Codex-backed agents gain automatic continuity for internal judgment calls during a model retirement. No endpoint, configuration, database, credential, user notice, external network integration, generated URL, or operator action is added. Other error types remain externally visible as failures.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Replicated by code rollout.** The fallback policy has no mutable state; every updated machine applies the same constant, classifier, registry check, and attempt bound independently. It emits no user-facing notice, holds no durable state, does not interact with topic transfer, and generates no URLs.

## 8. Rollback cost

Pure code rollback and patch release. No state migration or agent repair is required. During rollback propagation, a newly retired model would again fail loudly rather than corrupt state or silently choose arbitrary models.

## Conclusion

The recovery is intentionally smaller than a generic retry policy: one exact classified provider response, one registry-checked safe floor, one additional attempt. Boundary tests preserve visibility for neighboring errors and prove the fallback cannot loop. Clear to ship after full gates and CI.

## Second-pass review

Not required by the instar-dev high-risk list: this changes an internal provider error-recovery path, not messaging, session lifecycle, dispatch, compaction, trust, coherence, or a sentinel/guard/gate/watchdog.

## Evidence pointers

- `tests/unit/CodexCliIntelligenceProvider.test.ts`
- `tests/unit/codex-cli-provider-execjson.test.ts`
- `tests/unit/providers/adapters/openai-codex/observability/eventNormalizer.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller — not applicable.
