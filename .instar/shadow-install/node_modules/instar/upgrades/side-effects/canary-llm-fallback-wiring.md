# Side-effects review — wire canary LLM fallback into the application layer

**Version / slug:** `canary-llm-fallback-wiring`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive plumbing of an existing, tested fallback function into a previously-unused field on the pool config)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Rule 3 — state-detection robustness; the empty-prompt canary IS the Rule 3 self-test for the pool's idle detector)

## Summary of the change

Tasks #16 (canary LLM fallback) and the unit tests under `emptyPromptCanary-llmFallback.test.ts` established the `CanaryLlmFallback` contract and verified the canary calls it correctly when deterministic re-derivation fails. Until this change, that fallback was never threaded into the runtime — both call sites of `runEmptyPromptCanary()` inside `pool.ts` passed only the three required positional arguments and omitted the optional `options.llmFallback`. The fallback existed but was structurally dead at runtime.

This change wires the path end-to-end:

- `InteractivePoolConfig` grows an optional `llmFallback?: CanaryLlmFallback` field.
- Both `pool.ts` canary call sites pass `this.config.llmFallback` through to `runEmptyPromptCanary`.
- The adapter entry point exposes `buildCanaryLlmFallback(intelligence)` — a small helper that turns an `IntelligenceProvider` into a `CanaryLlmFallback` by sending a narrowly-scoped "is this pane at a completed prompt?" prompt to the fast tier (Haiku-class), parsing the single-word verdict, and treating provider errors as `'error'` (the canary's recipe-conservative outcome).

Application-layer wiring is now `createAnthropicInteractivePoolAdapter({ ..., llmFallback: buildCanaryLlmFallback(intelligence) })`. Omitting the field leaves the canary deterministic-only — a failed re-derivation surfaces as a hard fail, exactly as it did before this change.

Files touched:
- `src/providers/adapters/anthropic-interactive-pool/config.ts` — added optional `llmFallback` field + import of the `CanaryLlmFallback` type.
- `src/providers/adapters/anthropic-interactive-pool/pool.ts` — both `runEmptyPromptCanary` call sites now pass `{ llmFallback: this.config.llmFallback }`.
- `src/providers/adapters/anthropic-interactive-pool/index.ts` — new exported `buildCanaryLlmFallback` helper.
- `tests/unit/providers/adapters/anthropic-interactive-pool/buildCanaryLlmFallback.test.ts` — new, 8 cases covering parsing variants, error fail-safe, fast-tier routing budget, and bottom-30-line windowing of the prompt.

## Decision-point inventory

- **Canary self-heal verdict** — `pass-through`. The canary itself still decides what to do with the fallback verdict (see `emptyPromptCanary.ts` step 9). This change only ensures the fallback is reachable; the canary's existing decision logic is unchanged.
- **Application-layer config wiring** — `add`. Callers of `createAnthropicInteractivePoolAdapter` may now opt in to the LLM fallback by passing `llmFallback: buildCanaryLlmFallback(intelligence)`. Default behavior (no fallback) is unchanged.
- No new gates, no new authorities, no new blocking surfaces.

## Signal vs authority

The fallback is a signal producer (it returns one of `'complete' | 'not-complete' | 'error'`). The canary remains the only authority that decides what those signals mean for pool health. The helper does not gate anything — it returns a verdict that the existing canary logic interprets. Provider errors collapse silently to `'error'`, which the canary already treats as the conservative "do not trust" path.

## Over-block / under-block analysis

- **Over-block:** None. A misbehaving LLM that returns junk falls into the `'error'` branch, which the canary already treats as conservative-fail (same behavior as if no fallback were configured). The fallback can never cause a healthier verdict than the deterministic path would have produced when it succeeded.
- **Under-block:** Possible. If the canary's deterministic re-derivation has failed AND the LLM lies about what's on the pane (says "complete" when Claude Code is actually mid-generation), the canary will continue serving with a stale signature for one cycle longer. This is bounded by `canaryIntervalMs` (default 1h) — the next cycle re-runs the deterministic path. The risk is documented in `emptyPromptCanary.ts:218-264` as the explicit cost of keeping the pool operational rather than hard-failing on every UI shift.

## Level-of-abstraction fit

The helper lives in the adapter entry-point module because it bridges two abstractions: the pool's internal `CanaryLlmFallback` shape (defined in the canary module) and the application layer's `IntelligenceProvider` (defined in `core/types.ts`). Putting the bridge in `index.ts` keeps both inner modules ignorant of the application-layer LLM abstraction.

## Interactions

- **Existing canary tests** in `emptyPromptCanary-llmFallback.test.ts` still pass — they construct their own `vi.fn()` fallback and don't depend on the config wiring.
- **`InteractivePool.runScheduledCanary()`** and **`InteractivePool.spawnOne()`** are the only two consumers of the threaded value. Both pass it through identically.
- **Adapter factory tests** don't yet assert on `llmFallback` because no production wiring uses it yet. When the runtime is wired (a later phase), an integration test will exercise the live path.

## External surfaces

- `InteractivePoolConfig.llmFallback` — new optional field. Backwards-compatible (omitting it preserves prior behavior).
- `buildCanaryLlmFallback(intelligence)` — new exported helper from `anthropic-interactive-pool/index.ts`.
- No new endpoint, no new CLI command.

## Rollback cost

Trivial. `git revert` restores three source files + removes the new test. No persistent state changes. Pre-existing canary behavior is unchanged.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/adapters/anthropic-interactive-pool/` — 40/40 pass (8 new from buildCanaryLlmFallback.test.ts; 32 pre-existing unchanged).
- The bottom-30-line windowing assertion guards against the prompt growing unboundedly with pane history — a regression that would silently inflate per-canary token cost.
