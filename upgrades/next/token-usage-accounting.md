<!-- bump: patch -->

## What Changed

`/metrics/features` now reports real per-feature token usage instead of always
`tokensIn:0 / tokensOut:0`. Root cause (item 1 of the Iris-audit spec): the LLM
funnel's metrics tap recorded latency/outcome/count but never had token data —
`ClaudeCliIntelligenceProvider` ran `claude -p --output-format text`, which discards
the `usage` block, and `IntelligenceProvider.evaluate()` returns only a string.

The provider now runs `--output-format json`, parses the answer from `.result`, and
surfaces token counts through a new additive optional `onUsage` callback on
`IntelligenceOptions` — `evaluate()` still returns `Promise<string>`, so every existing
caller is byte-identical. `CircuitBreakingIntelligenceProvider` (the universal LLM
chokepoint) passes an `onUsage` that forwards `tokensIn/tokensOut` into the existing
`FeatureMetricsLedger`, so per-feature token cost is now real. `tokensIn` sums the
input components actually processed (fresh + cache-creation + cache-read); `tokensOut`
is output tokens. Parsing is defensive — non-JSON or a missing `.result` falls back to
the raw text, so a malformed response degrades to "answer without token accounting,"
never a crash.

## What to Tell Your User

- **The token cost screen works now.** "My per-feature cost view used to show 0 tokens
  for everything even though my background checks clearly cost tokens — the number was
  never being recorded. It now shows real token usage, so we can actually see which
  checks are expensive and tune them."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Real per-feature token usage | `GET /metrics/features` — `tokensIn` / `tokensOut` now populated |

## Evidence

- **Root cause:** `ClaudeCliIntelligenceProvider` used `--output-format text` and the
  `CircuitBreakingIntelligenceProvider` tap (`recordMetric`) passed no tokens, so
  `FeatureMetricsLedger`'s token columns were always null → summed to 0.
- **Live CLI shape verified:** `claude -p --model haiku --output-format json` returns
  `{ result:"ok", usage:{ input_tokens:10, output_tokens:41, cache_*:… } }`.
- **Tests:** `tests/unit/ClaudeCliIntelligenceProvider-jsonParse.test.ts` (parser
  contract + defensive fallbacks) and `tests/unit/CircuitBreaking-feature-metrics-tap.
  test.ts` (funnel forwards tokens; sums into the real ledger rollup, no longer 0).
