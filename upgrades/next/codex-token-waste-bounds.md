# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Two internal background LLM callers were spending tokens without getting results. Both are now bounded:

- **Topic-intent capture offers at most 40 existing refs per extraction prompt.** `captureTurn` rendered every observation-or-above ref the topic had ever established into each extraction prompt, and the store never prunes, so the prompt grew with the topic's age. The busiest measured topic had 858 refs, and `TopicIntentExtractor` averaged 42k input tokens a call, about 7M a day on one machine. A new pure `selectPromptRefs` ranks refs by projected tier, then by most recent reinforcement, and offers the top `MAX_PROMPT_REFS = 40`. The store is untouched. `TopicIntentArcCheck`, the contradiction check, is intentionally left uncapped.
- **Session-activity digests get a 90 s call budget.** The digest, synthesis and retry calls rode the Codex provider's 30 s default. On Codex they take about 30 s, so 143 of 280 calls in a day were killed at the limit after spending their input tokens, then re-queued. They now pass `timeoutMs: 90_000` (the slowest observed success took 49 s). The calls are background and non-gating.

No config, route or on-disk format changes.

## What to Tell Your User

Your agent's background checks now use noticeably fewer tokens. One check was re-reading the full history of notes for long-running conversations on every message, which cost more the longer a conversation ran. It now reads only the most relevant recent ones. Another check was giving up on work just before it finished and throwing away what it had already paid for. It now gets enough time to finish. Nothing changes in how your agent behaves; it just wastes less of your usage allowance.

## Summary of New Capabilities

- Lower internal token spend on long-running conversations (the goal tracker's cost no longer grows with a topic's age).
- Session-activity memory digests complete instead of timing out on Codex.

## Evidence

- Live 24h metrics on the Studio (v1.3.1253): `TopicIntentExtractor` 167 calls / 7,031,207 input tokens (avg 42,103); ref counts per topic file 858, 474, 409, 403, 389, 330. `SessionActivitySentinel` 280 calls, 143 errors, every error latency ≥ 30,007 ms; successful calls 6.4–49.4 s.
- Tests: `tests/unit/TopicIntentCapture.test.ts` (+3: the cap holds on a 100-ref topic and fails against the pre-fix code; under-cap passthrough; deterministic ranking). `tests/unit/session-activity-sentinel.test.ts`: digest and synthesis calls carry `DIGEST_LLM_TIMEOUT_MS`.
