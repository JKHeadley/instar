## What Changed

Added the forward-ratchet enforcement for the "No Silent Degradation to Brittle Fallback" safety standard: `tests/unit/no-silent-llm-fallback.test.ts`. It enumerates every file that calls an LLM (`IntelligenceProvider.evaluate()`) and requires each to either carry a safety marker (degradation is reported, or the call is marked gating so it swaps providers and fails closed) or be listed as reviewed-advisory with a reason. A new LLM call that ships a silent brittle fallback in a gating path now fails CI instead of slipping through. Also recorded the round-2 convergence audit in the standard's spec: 44 callsites swept, zero dangerous fail-open gates remaining (the two that existed were fixed earlier), 23 classified as benign-advisory.

## Evidence

The audit that prompted this standard found two safety gates that returned a permissive verdict when their LLM was rate-limited — failing open exactly when they mattered. Those were fixed (fail-closed) and the provider-swap was added. This lint is the structural guard that stops a new one from being introduced: before it, a fresh gate with a silent heuristic fallback would pass CI unnoticed; now it fails the ratchet until the author swaps, fails closed, reports the degradation, or explicitly classifies the call as advisory. Verified by running the test against current main — it discovers 44 callsites and passes only because all are marked or reviewed; adding an unmarked gating callsite makes it fail with the offending file named.

## What to Tell Your User

I added a guard that makes it impossible to quietly ship a safety check that silently falls back to dumb logic when its AI is unavailable — any new one has to either switch to a backup provider, refuse safely, or be explicitly reviewed. I also finished a full sweep and confirmed there are no remaining dangerous spots.

## Summary of New Capabilities

- A CI ratchet over every LLM call site that prevents new silent LLM-to-heuristic fallbacks in gating paths, backed by a documented, staleness-checked classification of every existing call site.
