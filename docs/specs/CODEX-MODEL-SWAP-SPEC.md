---
title: Auto-swap the codex launch model to a fallback when the weekly window is exhausted
review-convergence: retrospective-single-pass
approved: true
eli16-overview: CODEX-MODEL-SWAP.eli16.md
---

# Codex Rate-Limit Model-Swap

## Problem

A codex agent's main model (e.g. `gpt-5.5`) draws on an account quota with a 5h
and a weekly window. When the weekly window is exhausted, codex starts failing —
and the agent stalls. Codex offers other models (e.g. a Codex-Spark tier) on
SEPARATE quota buckets. Justin's ask (2026-05-30): "swap to GPT-5.3-Codex-Spark
when the other usage hits the limit." This makes that swap automatic.

Builds directly on `GET /codex/usage` / `readLatestCodexUsage`
(CODEX-USAGE-VISIBILITY-SPEC) — the authoritative on-disk rate-limit reader is
the signal source. The `rate_limit_reached_type` field and the weekly window's
remaining percent are what the policy reacts to.

## Solution

A pure decision + a launch-path hook. A running session can't change model
mid-turn, so the swap naturally applies at the NEXT session launch — exactly
when it matters.

1. **`codexModelSwapPolicy.ts`** (openai-codex/observability):
   - `resolveCodexLaunchModel({ framework, requestedModel, config, usage })` —
     PURE. Returns the fallback model when: framework is codex-cli AND the swap
     is enabled AND a `fallbackModel` is configured AND not already on it AND
     usage shows exhaustion (`rate_limit_reached_type` set, OR the weekly
     window's `remainingPercent <= weeklyRemainingThreshold`, default 10).
     Otherwise returns the requested model unchanged. Never throws.
   - `resolveCodexLaunchModelWithUsage({ ..., readUsage? })` — best-effort async
     wrapper. Fast-path guards (non-codex / disabled / no fallback) return
     immediately with ZERO disk I/O. Otherwise reads usage (injectable for
     tests) and applies the pure policy. A read failure resolves to "no swap" —
     it NEVER blocks a launch.

2. **`SessionManager`** — a private `resolveCodexLaunchModel(framework, model)`
   helper reads `config.codex.rateLimitModelSwap` and delegates to the wrapper.
   BOTH codex launch paths call it: the headless path (`spawnSession` →
   `buildHeadlessLaunch`) and the interactive/user-facing path
   (`spawnInteractiveSession` → `buildInteractiveLaunch`). The resolved model is
   what the builder launches with. No separate poller — the decision is made at
   the one moment it can take effect (launch).

## Config (dark by default)

`.instar/config.json` → `codex.rateLimitModelSwap`:
```
{ "enabled": false,                       // master switch; absent/false = off
  "fallbackModel": "<codex model id>",    // REQUIRED to swap — operator-set
  "weeklyRemainingThreshold": 10 }        // swap when weekly remaining <= this %
```
Ships DARK: absence of the block = disabled = zero spawn-path overhead. The
`fallbackModel` id is intentionally NOT defaulted — the exact Codex-Spark
`--model` string and its availability on a given ChatGPT subscription are the
account owner's to confirm (it is not in instar's probed model list,
`models.ts`). The operator sets the verified id to arm the feature.

## Signal vs authority

This is a signal-driven DECISION with no blocking authority (ref
`docs/signal-vs-authority.md`). It reads a signal (usage) and PICKS a model. It
blocks nothing, filters no message, and fails safe (read failure → launch with
the requested model). It consumes the CODEX-USAGE-VISIBILITY signal; it adds no
brittle gate.

## Testing

- **Unit** (`codexModelSwapPolicy.test.ts`, 16) — the pure policy + the wrapper,
  both sides of every guard (threshold, reached-flag, non-codex, disabled,
  no-fallback, already-on-fallback, null-usage, missing-window, read-throws,
  zero-disk-IO fast-paths).
- **Integration** (`codex-model-swap-integration.test.ts`, 3) — the wrapper with
  the REAL `readLatestCodexUsage` against a rollout fixture (exhausted → swap;
  healthy → no swap; no data → no swap).
- **Wiring** (`codex-model-swap-wiring.test.ts`, 7) — reflection on
  `SessionManager.resolveCodexLaunchModel` (deterministic fast-paths, no disk) +
  source assertions that BOTH spawn paths launch with the resolved model (so the
  swap can't be silently disconnected from a path).

A live end-to-end "spawn a real codex session on the fallback" test is NOT
included: it would consume real account quota and depends on the operator's
verified Spark id — out of scope for CI. The integration test covers the
read→decide path against real on-disk data; the wiring test covers the spawn
hookup.

## Rollback

Pure additive + dark. Back-out = revert the policy module + the SessionManager
helper/wiring + tests. No data migration, no state repair. Because it ships off
(config absence), a bad interaction can also be neutralised in the field by
simply not setting `codex.rateLimitModelSwap.enabled` (or removing it).

## Authority note

Shipped autonomously under the 12-hour session's "merge → release → deploy →
verify" mandate, which delegates the `approved: true` flip; flagged in the PR
for async human review. `review-convergence: retrospective-single-pass` reflects
single-pass convergence during the autonomous run. The mechanism ships armed-by-
config; Justin confirms the Spark `--model` id before enabling.
