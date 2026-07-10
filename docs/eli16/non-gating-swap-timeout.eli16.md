# Non-gating swap timeout — ELI16

Instar routes many internal LLM calls through an `IntelligenceRouter`. Some of
those calls are safety-gating calls: if the model path fails, the system must
decide quickly and fail closed. Those calls use the existing global
`intelligence.swapAttemptTimeoutMs`, which defaults to 5000ms. That short bound
is intentional because a gate should not sit around waiting while the user or an
operation is blocked.

PR #1410 added a separate rescue path for non-gating internal calls. These are
background or advisory calls, such as classification and extraction work, where
a provider failure should not force an immediate heuristic fallback if another
healthy provider can answer. The rescue path is deliberately smaller than the
gating one in reach: it tries only a bounded off-Claude target and never herds
background traffic onto the Claude tail.

The bug was that this non-gating rescue used the same 5000ms timeout as safety
gates. That is too short for cold-start providers like `pi-cli`. A provider can
be healthy but need more than five seconds to start, so the non-gating swap would
time out and log `nongating-swap-attempt-timeout: pi-cli` even though waiting a
little longer would have avoided the heuristic fallback.

This change gives non-gating swaps their own timeout knob:
`intelligence.nonGatingSwapTimeoutMs`, defaulting to 15000ms. The server passes
that value into the router only for the non-gating swap helper. The normal
gating/deferrable swap loop still uses `intelligence.swapAttemptTimeoutMs`, so
the safety-gating fail-closed path remains at the existing 5000ms default.

The default is seeded through `ConfigDefaults`, which means fresh installs and
existing agents both receive the value by the normal add-missing migration path.
If an operator already set a value, migration leaves it alone. The existing
per-framework caps still work as the more specific override for a target; the
new value is the non-gating global fallback where the old global 5s cap used to
be.

The tests prove both sides of the boundary. A non-gating call that swaps to a
6-second provider now succeeds and passes `timeoutMs: 15000` to that provider. A
gating call with the same 6-second target still times out at 5000ms and fails
closed. Integration and e2e coverage use the same production-shaped router
wiring so the test covers the server construction path, not just a standalone
helper.
