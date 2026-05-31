# Side-effects — Mentor LLM rate-limit gate

## 1. What files/state does this touch at runtime?
`MentorOnboardingTick.ts` (new `llmAvailable` dep + a gate), `MentorOnboardingRunner.ts` (computes
`llmAvailable` from the circuit), `LlmCircuitBreaker.ts` (a new read-only `llmCircuitAvailable()`
helper). No new state, config, or schema.

## 2. Does it change any functional behavior?
The mentor onboarding tick now SKIPS (returns `{ran:false, reason:'llm-rate-limited'}`) when the
shared LLM circuit is open/half-open, instead of running Stage A + Stage B and failing. When the
circuit is closed (or disabled), behavior is unchanged.

## 3. What happens on failure / weird config?
If the breaker is disabled, `llmCircuitAvailable()` returns true (the mentor runs as before). The
helper is read-only (cannot throw on a normal status read). A skipped tick is simply retried on the
next eligible cycle — no work is lost (the mentor's forensics are not time-critical).

## 4. Migration parity — do existing agents get it?
Yes, via the normal release — code-only, compiled into `dist`. No agent-installed file / config /
template change → no `PostUpdateMigrator` pass.

## 5. Could it spam / flood / burn resources?
The opposite — it REDUCES burn: it stops the mentor from firing doomed LLM calls at a throttled
provider and re-tripping the circuit (each trip pauses all LLM-backed work ~900s). The added work is
one read-only circuit-status read per tick.

## 6. Rollback / off-switch?
Revert the gate + the `llmAvailable` dep + the helper. No data, no migration, no flag.

## 7. Concurrency / ordering?
Gate order is budget → llm-rate-limit → safe-window (budget still wins a tie; fail-closed precedence
unchanged). The circuit query is non-mutating — it does NOT consume the breaker's half-open probe
slot, so it can't perturb the breaker's recovery.

## Blast radius
Small + contained, mentor-only. One gate in the onboarding tick + a read-only circuit helper. Only
mentor-enabled agents (the mentor ships dark elsewhere) are affected, and only when the LLM circuit
is open. The dark autonomous-fix guardian makes LLM calls too and should get the same gate — noted as
a small follow-up, not bundled here.
