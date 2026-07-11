# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Internal Codex calls now recover automatically when OpenAI retires their selected model from the ChatGPT-account Codex surface.

## What to Tell Your User

A Codex model retirement no longer silently breaks classifications, gates, tone checks, and commitment checks fleet-wide. Instar retries that exact failure once on a known-good safe model while leaving every other error unchanged.

## Summary of New Capabilities

- Exact unsupported-model classification for the ChatGPT-account retirement response.
- One bounded retry on the live-verified `gpt-5.4-mini` floor.
- No fallback for rate limits, authentication failures, unrelated 400s, timeouts, or network failures.
- Equivalent recovery in structured and legacy Codex execution modes.

## Evidence

Boundary unit tests cover retirement recovery, non-retry error classes, and bounded fallback failure. Structured exec-path coverage proves the real spawn path retries with the safe model and succeeds. Full lint, build, and three-tier tests gate release.
