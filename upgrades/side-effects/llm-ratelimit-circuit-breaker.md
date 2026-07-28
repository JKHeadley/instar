# Side-effects review — account-global LLM rate-limit circuit breaker

**Scope**: Stop the runaway credit-burn failure mode where an LLM-call loop
keeps invoking the provider after the account is over its usage/spend limit.
Motivating incident (2026-05-28): a wild agent burned $452/$455 because
PromptGate's per-tick Haiku detection loop kept spawning `claude -p` against
the weekly-limit screen with no backoff on the rate-limit error; the account's
auto-reload refueled the burn each cycle.

Distinct from — and complementary to — the existing volume-based
token-burn-detection system (BurnDetector + LlmRateGate, ~30-min statistical
reaction). This breaker reacts in milliseconds to the provider's OWN rate-limit
signal: once the provider says "over limit," every further call is wasted
(rejected) or harmful (auto-reload), so we stop immediately.

**Files touched**:
- `src/core/LlmCircuitBreaker.ts` — NEW. Account-global breaker
  (closed/open/half-open, single-probe invariant, configurable open window,
  default 15 min) + the pure exported `isRateLimitError()` classifier + typed
  `RateLimitError` / `LlmCircuitOpenError` + process singleton + `configure()`.
- `src/core/CircuitBreakingIntelligenceProvider.ts` — NEW. Decorator that gates
  every `evaluate()` on the breaker BEFORE delegating; trips on rate-limit,
  closes on any other outcome; `wrapIntelligenceWithCircuitBreaker()` helper
  (null-safe, idempotent).
- `src/core/intelligenceProviderFactory.ts` — wrap every provider the factory
  returns (the single chokepoint).
- `src/commands/server.ts` — `configureLlmCircuitBreaker()` from config at
  startup; wrap the three direct `new ClaudeCliIntelligenceProvider` fallback
  sites.
- `src/commands/reflect.ts` — wrap its direct fallback site.
- `src/core/ClaudeCliIntelligenceProvider.ts` / `CodexCliIntelligenceProvider.ts`
  — widen the captured stderr slice 200 → 600 so the rate-limit phrase isn't
  truncated before classification.
- `src/core/types.ts` — optional `intelligence.circuitBreaker` config block.
- Tests: `tests/unit/LlmCircuitBreaker.test.ts` (31),
  `tests/unit/CircuitBreakingIntelligenceProvider.test.ts` (6),
  `tests/integration/llm-circuit-breaker-chokepoint.test.ts` (2, real subprocess
  spawn-counter proof of account-global short-circuit).

**Under-block** (does it fail to stop something it should?): The breaker only
trips on errors the classifier recognizes as usage/rate/spend limits. If a
provider emits limit language the classifier doesn't match, the loop is not
stopped by THIS layer — but the volume-based BurnDetector remains the backstop.
The classifier is deliberately broad (429/402, "rate limit", "usage limit",
"quota", "limit reached/resets", "credit balance too low", "payment required",
"exceeded …"), and the stderr-slice widening reduces truncation misses.

**Over-block** (does it stop something it shouldn't?): A false positive trips
the breaker and degrades ALL LLM-backed features (PromptGate, PresenceProxy,
PromiseBeacon, sentinels, reviewers) to heuristic-only for one open window
(default 15 min), after which a single probe self-heals. The classifier
excludes generic error/timeout/ENOENT/parse text to avoid this. Worst case from
a false trip is bounded, reversible, and self-healing — and is strictly safer
than the unbounded credit burn it prevents. A non-rate-limit error during a
probe closes the breaker (does not keep features down on unrelated errors).

**Level-of-abstraction fit**: The breaker is wired at the IntelligenceProvider
construction chokepoint, so every current and future consumer is covered without
per-consumer code (Structure > Willpower). Consumers that already swallow
provider errors (PromptGate's silent fallback) swallow `LlmCircuitOpenError`
too — the desired behaviour: skip the LLM step at zero subprocess cost.

**Signal vs authority**: No new blocking authority over jobs/messages/sessions.
The breaker only gates LLM dispatch in reaction to the provider's own response.
It does not decide policy; it enforces "the provider said no."

**Migration / fleet reach**: Pure `src/` code shipped via the normal release →
AutoUpdater path. The protection is default-ON and reads config defensively with
built-in defaults, so it reaches every existing agent on the version bump with
NO config migration required. No agent-installed file (hooks/settings/CLAUDE.md
template/skills) changed → no PostUpdateMigrator entry needed.

**Rollback**: `intelligence.circuitBreaker.enabled: false` in `.instar/config.json`
makes the breaker a transparent passthrough. Full revert is a code revert of the
additive files.
