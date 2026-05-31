<!-- bump: patch -->

## What Changed — The mentor routine no longer hammers a rate-limited provider and re-trips the pause

Agents can run a "mentor" routine that periodically studies a mentee agent using the AI model. There's also a safety breaker that pauses all AI work for a while when the provider says you're going too fast (rate-limited). The mentor checked its spending budget before running, but not whether the AI was currently rate-limited — so while the provider was throttled, the mentor kept firing off doomed analyses that failed and re-tripped the pause, restarting it again and again. The agent was effectively tripping itself.

Now the mentor also checks the breaker: if the AI is currently rate-limited, it skips this round and picks up on the next one, instead of throwing a doomed request at a throttled provider and re-pausing all the agent's other AI-backed monitors.

## Summary of New Capabilities

- The mentor onboarding tick now gates on LLM availability (the shared rate-limit circuit breaker) in addition to budget and safe-window: when the provider is rate-limited it backs off with reason `llm-rate-limited` and resumes automatically when the breaker closes. A new read-only `llmCircuitAvailable()` helper exposes the breaker state without consuming its recovery probe.

## What to Tell Your User

If you run an agent with the mentor routine enabled, it will stop making things worse during AI rate-limit periods — it now waits for the provider to recover instead of repeatedly tripping the system-wide pause. Nothing to configure.

## Evidence

- Found in the agent's own server log: the LLM circuit breaker opening repeatedly (trip #7) on the mentor's `claude -p` forensics call.
- The mentor tick gated on budget but not on the rate-limit circuit, so it ran LLM-backed Stage A + Stage B while the provider was throttled, re-tripping the breaker (which pauses all LLM-backed work ~900s per trip).
- Unit tests: the tick skips with reason `llm-rate-limited` BEFORE any spawn/forensics when the circuit is open; budget is still checked first; the existing gate-order and happy-path cases stay green.
