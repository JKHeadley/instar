---
review-convergence: "Echo/User task brief accepted for direct implementation; narrow capability change self-reviewed against local gates"
approved: true
parent-principle: "Zero-Failure"
eli16-overview: gemini-capacity-policy.eli16.md
---

# Gemini Capacity Policy Spec

## Problem

Gemini CLI provider calls can fail with quota or capacity errors that include a reset window. Before this change, those failures were treated like ordinary provider errors. That caused repeated respawns during known long reset windows, and raw model identifiers such as `gemini-2.0-flash` could be passed through even when the local system only has a vetted Gemini model set.

## Requirements

1. Gemini provider execution must detect capacity-shaped failures from stderr, stdout, or mapped provider errors.
2. Reset windows must be parsed from common Gemini text shapes such as `7h32m28s`, `45s`, and `2 minutes`.
3. Short windows must retry in-process with a bounded attempt count and bounded wait.
4. Long or unknown windows must open a process-local cooldown so the next call returns quickly instead of spawning Gemini again.
5. Retry-after timing must be preserved on mapped `RateLimitError` and `QuotaError` objects when available.
6. Gemini model resolution must only pass through locally known Gemini model identifiers.
7. Unknown Gemini model identifiers must fall back to the local default known model.
8. The same capacity policy must apply to the adapter one-shot path and the `GeminiCliIntelligenceProvider` path.

## Design

The Gemini CLI adapter owns a small observability policy module that classifies capacity text, parses reset windows, chooses retry versus cooldown, and records a local cooldown gate per model. Both Gemini execution paths consult the gate before spawning the CLI and apply the decision after non-zero exits.

Known model handling is centralized around `KNOWN_GEMINI_MODELS`. The router, framework session launcher, and Gemini model flag resolver agree on the same known set so a stale or unsupported Gemini model id cannot drift into a failing CLI invocation.

## Tests

The required evidence is:

- Unit coverage for capacity classification, reset parsing, retry/cooldown decisions, cooldown gate behavior, and known-model fallback.
- Integration coverage with a fake Gemini executable proving short windows retry and long windows prevent a second spawn.
- E2E coverage through `GeminiCliIntelligenceProvider` proving the live provider path honors the cooldown lifecycle.
- Typecheck and build coverage before PR.

## Rollout

The behavior is local and conservative. It does not add a service dependency, persistent storage, or a network call. Cooldown state is process-local, intentionally short-lived, and derived only from Gemini CLI capacity output.
