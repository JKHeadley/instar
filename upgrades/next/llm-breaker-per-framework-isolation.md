## What Changed

Added a regression test that pins the per-framework circuit-breaker isolation
contract: each framework provider (`claude-code`, `codex-cli`, `pi-cli`,
`gemini-cli`) carries its OWN `LlmCircuitBreaker`, so a claude-code rate-limit trip
does NOT block a call routed to a different framework. The test opens claude's real
breaker via a rate-limit error and asserts a pi-cli-routed gating call still
succeeds while a claude-routed call is short-circuited. Also corrected the breaker's
OPEN log line — it said "pausing ALL LLM-backed work" (reads as global; caused a
real misdiagnosis on 2026-06-25) to "pausing further calls on THIS provider … other
frameworks have their own breakers." No behavior change; pure clarity + a test.

## What to Tell Your User

Nothing changes in how the system behaves — the AI engines were already isolated, so
one engine getting rate-limited never actually froze the others. This just locks
that guarantee in with a test and fixes a log message that made it look like one
engine's trouble froze everything. There is nothing to configure.

## Summary of New Capabilities

- A regression test now guarantees one engine's rate-limit trip cannot freeze the
  other engines (it would fail if anyone ever wired them together).
- The breaker's log message is accurate about its per-engine scope.

## Evidence

- **Reproduction:** With a router whose default (claude-code) provider is wrapped in
  a real breaker, send a rate-limited gating call to trip claude's breaker.
- **Observed (the contract):** A subsequent gating call routed to pi-cli returns its
  verdict normally; a call routed back to claude-code is rejected with the open-circuit
  error; pi-cli remains usable across repeated calls and its breaker never trips.
- **Before/after on the log:** previously the OPEN line read "pausing ALL LLM-backed
  work"; now it reads "pausing further calls on THIS provider … other frameworks have
  their own breakers." 38/38 breaker-related unit tests pass.
