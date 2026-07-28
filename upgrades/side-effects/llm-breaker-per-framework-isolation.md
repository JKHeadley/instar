# Side-Effects — per-framework circuit-breaker isolation: regression test + log-wording clarity

**Tier:** 1 (one log-string change + one new unit test; no behavior change)
**Branch:** echo/llm-breaker-isolation-test (off JKHeadley/main @ v1.3.667)
**Files:** `src/core/LlmCircuitBreaker.ts`, `tests/unit/llm-breaker-per-framework-isolation.test.ts`

## What changed
1. **Test (new):** `tests/unit/llm-breaker-per-framework-isolation.test.ts` pins the
   contract that each framework provider carries its OWN `LlmCircuitBreaker`
   instance, so a claude-code (claude -p) rate-limit trip does NOT block a call
   routed to a different framework (pi-cli). It opens claude's real breaker via a
   rate-limit error, then asserts: a pi-cli-routed gating call still succeeds; a
   claude-routed call is short-circuited with `LlmCircuitOpenError`; pi stays usable
   across repeated calls.
2. **Log wording:** the breaker's OPEN log said "pausing ALL LLM-backed work" — which
   reads as a GLOBAL pause and directly caused a misdiagnosis during the 2026-06-25
   incident. Changed to "pausing further calls on THIS provider … other frameworks
   have their own breakers" — accurate (the breaker is per-provider; an account-wide
   rate-limit legitimately backs off every call to THAT provider, never cross-provider).

## Why
During the 2026-06-25 backend-reliability incident, the operator and I both read
"pausing ALL LLM-backed work" as evidence of a global pause. The real cause of the
perceived global pause was the tone gate FALLING BACK to rate-limited claude-code via
the failure-swap chain (fixed separately at config level). This change makes the
breaker's true (per-provider) scope explicit in both the log and a regression test.

## Blast radius
- **Log line:** one string; cosmetic, no behavior change. Nothing parses this line
  (verified: no test asserts the old wording).
- **Test:** additive; uses only public APIs (IntelligenceRouter, LlmCircuitBreaker,
  CircuitBreakingIntelligenceProvider). Pins existing behavior — it does not change it.
- **Risk:** negligible. No production code path alters.

## Rollback
Revert the one-line wording change; delete the test file.

## Verification
- New test green; full LlmCircuitBreaker.test.ts (31) + CircuitBreakingIntelligenceProvider.test.ts (6) + the new isolation test (1) = 38/38 pass.
- Confirms completion-condition #2 of the topic-28744 fix session ("breaker is
  per-framework — a claude-code trip does NOT pause pi/gemini/codex — code + test").

## Tests
- `tests/unit/llm-breaker-per-framework-isolation.test.ts` — the isolation contract.
