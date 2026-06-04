# Side-Effects Review — Gemini capacity policy

**Version / slug:** `gemini-capacity-policy`
**Date:** `2026-06-03`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds a Gemini-specific capacity policy beside the existing Gemini
adapter observability code. Gemini one-shot calls now classify quota/rate-limit
failures, parse reset windows such as `quota will reset after 7h32m28s`, retry
only short capacity windows once, and record a process-local defer window for
longer quota exhaustion. While deferred, later calls fail locally with a retry
hint instead of spawning another Gemini CLI process that would hit the same
quota wall.

Review update: the optional `capacityPolicy.fallbackModel` is now wired into
the retry loop instead of only being resolved in the policy decision. Both
Gemini execution paths rebuild `gemini -m <model>` on each retry attempt from
the current policy-selected model, so a configured fallback actually changes
the spawned CLI argv. Explicit caller-supplied raw model ids still pass through
the primary resolver; only automatic capacity fallback is constrained to known
Gemini models.

The change also constrains automatic Gemini fallback selection to verified known
models: `gemini-2.5-flash` and `gemini-2.5-pro`. Explicit raw Gemini model ids
continue to pass through to the CLI because they represent caller intent. The
bad `gemini-2.0-flash` fallback observed during the mentor loop is avoided by
the known-only fallback helper rather than by rewriting every raw model id.

## Decision-point inventory

- `isGeminiCapacityError` — add — classifies Gemini quota/rate-limit/capacity
  error strings.
- `parseGeminiRetryAfterMs` — add — extracts reset windows from Gemini stderr.
- `decideGeminiCapacityPolicy` — add — chooses `none`, `retry`, or `defer`.
- `recordGeminiCapacityDeferral` / `getGeminiCapacityGate` — add — process-local
  defer state for Gemini calls.
- Gemini fallback resolution — modify — automatic capacity fallback ids must be
  in the known set or the current caller-selected model is kept.
- `GeminiCliIntelligenceProvider` and adapter one-shot transport — modify — both
  apply the policy before and after spawning Gemini.
- Retry argv rebuild — modify — short-window retries rebuild the Gemini argv
  from `decision.model`, so `capacityPolicy.fallbackModel` is applied to the
  next spawned process.

---

## 1. Over-block

The main over-block risk is a false-positive capacity classification that defers
Gemini when the failure was not actually quota related. The classifier is
deliberately narrow: explicit `429`, `QUOTA_EXHAUSTED`, `resource exhausted`,
`rate limit`, quota, usage-limit, or capacity language. Generic parse errors,
syntax errors, binary-not-found errors, and ordinary non-zero exits do not defer.

The known-model constraint applies only to automatic capacity fallback. Explicit
caller-selected Gemini model ids still pass through to the CLI, so newly valid
Gemini ids are not blocked by this policy. If `capacityPolicy.fallbackModel` is
unknown, the retry keeps the caller's current model instead of swapping to a
guessed fallback.

## 2. Under-block

This policy is process-local. A server restart forgets the defer window and the
first post-restart Gemini call may probe the provider again. That matches the
existing LLM circuit-breaker shape and keeps the change small. A future durable
capacity ledger could persist provider reset windows across restarts if repeated
restart-probes become noisy.

This does not discover the full Gemini model catalog dynamically. It uses the
currently verified set and keeps the list explicit. Dynamic discovery is a
separate model-catalog problem, not part of quota handling.

## 3. Level-of-abstraction fit

The policy belongs at the Gemini provider boundary, not at each caller. The
adapter one-shot transport and live `GeminiCliIntelligenceProvider` are the
places that see Gemini stderr and own whether to spawn Gemini again. Keeping the
decision there means reviewers, route, setup narrative calls, and future Gemini
one-shots share the same capacity behavior.

Known-model fallback belongs in the capacity-policy fallback helper because that
is the only automatic model swap path in this change. Primary model resolution
still maps canonical tiers and otherwise respects explicit raw model ids.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Not applicable to conversational/product judgment — this is deterministic
  provider-capacity handling and model-id validation at the transport boundary.

The defer gate is not making a semantic judgment about user intent. It acts only
after Gemini itself reports a quota/capacity condition or while the recorded
reset window from that provider report is still active.

## 5. Interactions

- **Global LLM circuit breaker:** The Gemini provider still throws clear
  quota/rate-limit text, so the existing circuit breaker can continue to observe
  and pause broader LLM-backed work. The Gemini policy additionally prevents
  repeated Gemini subprocesses during a known Gemini reset window.
- **Setup wizard:** Gemini narrative fallback continues to work; quota failures
  become clearer and do not repeatedly spawn Gemini.
- **Route override detector:** The known-model list now includes
  `gemini-2.5-flash`, so the verified default is recognized.
- **Session launch:** Unchanged by the capacity fallback review fix; the
  known-model gate is isolated to automatic provider retry fallback.

## 6. External surfaces

Users may see clearer Gemini quota/defer errors instead of a generic Gemini CLI
failure or a stalled task. Operators can rely on `gemini-2.5-flash` as the safe
automatic capacity fallback when configured. Explicit caller-supplied model ids
continue to pass through. No config migration, schema change, or external API
change is introduced.

## 7. Rollback cost

Rollback is a code revert of the Gemini policy module, the two provider wiring
changes, the fallback known-list change, tests, and these artifacts. No
data migration is required. A running process that had recorded a defer window
would forget it on restart.

## Conclusion

The change is a narrow sibling to the Codex capacity/model-swap work, scoped to
Gemini's actual error and model surfaces. It prevents repeated doomed Gemini CLI
spawns during quota windows, avoids guessed model fallbacks, and pins the
behavior with unit, integration, and E2E tests.

## Evidence pointers

- `tests/unit/geminiCapacityPolicy.test.ts`
- `tests/integration/gemini-capacity-policy-integration.test.ts`
- `tests/e2e/gemini-capacity-policy-lifecycle.test.ts`
- `tests/unit/frameworkSessionLaunch.test.ts`
