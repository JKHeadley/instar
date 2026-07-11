# ELI16 — Codex model retirements self-heal

## What Changed

OpenAI can remove a model from the ChatGPT-account Codex surface without changing Instar. Previously, every small internal Codex judgment call using that model would begin failing until a person found the incident and manually changed the tier map. Instar now recognizes Codex's specific model-retirement response and retries that one call once with a live-verified safe model.

## What to Tell Your User

A retired Codex model should no longer take down classifications, gates, tone checks, or commitment checks across the fleet. The recovery is intentionally narrow: it does not swap models for rate limits, login problems, network failures, or unrelated bad requests, so those real problems remain visible instead of being hidden behind a retry.

## Summary of New Capabilities

- Classify Codex's exact ChatGPT-account “model not supported” response as an unsupported-model signal rather than generic authentication failure.
- Retry once on `gpt-5.4-mini`, the designated live-verified safe floor and a member of Instar's known Codex model registry.
- Preserve the original failure behavior for 429s, authentication errors, unrelated 400s, timeouts, and network failures.
- Stop after the fallback attempt and surface its error if it also fails; there is no recursive or unbounded retry path.
- Apply the same recovery to both the default structured exec path and the legacy plain-output kill-switch path.

## Evidence

Unit coverage proves both sides of the classification boundary, the exact two-model attempt sequence, fallback failure surfacing, and non-retry behavior for neighboring errors. Exec-path coverage drives the real structured spawn helper through retirement and recovery. Existing provider, event-normalizer, lint, build, and three-tier suites remain the release gates.
