# Side-Effects Review — Iris-audit token usage accounting (PR B: item 1)

**Version / slug:** `iris-audit-token-accounting`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `convergence reviewers (shared spec) — concur`

## Summary of the change

PR B of the Iris-audit spec (`docs/specs/iris-audit-session-observability.md`), item
1: make `/metrics/features` report real per-feature token usage instead of always 0.
`ClaudeCliIntelligenceProvider` switches `claude -p` from `--output-format text` to
`json` and parses the result object for the answer (`.result`) and `usage`; a new
additive optional `onUsage` callback on `IntelligenceOptions` surfaces the token
counts. `CircuitBreakingIntelligenceProvider` (the universal LLM funnel) passes an
`onUsage` that captures usage and forwards `tokensIn/tokensOut` into the existing
`FeatureMetricsLedger` tap. Files: `src/core/types.ts`, `src/core/
ClaudeCliIntelligenceProvider.ts`, `src/core/CircuitBreakingIntelligenceProvider.ts`,
plus tests. The decision points touched are observability-only — no gate changes.

## Decision-point inventory

- `IntelligenceOptions.onUsage` (types.ts) — **add** — optional callback; no decision
  logic.
- `ClaudeCliIntelligenceProvider.evaluate` output parsing (ClaudeCliIntelligence
  Provider.ts) — **modify** — text→json + `parseJsonResult`; affects the return-value
  extraction for EVERY Claude-backed LLM call, but the returned text is unchanged.
- `CircuitBreakingIntelligenceProvider` metrics tap (CircuitBreakingIntelligence
  Provider.ts) — **modify** — now forwards token counts; observability only.

## 1. Over-block

No block/allow surface — over-block not applicable. This is pure observability
plumbing; nothing is rejected.

## 2. Under-block

No block/allow surface — under-block not applicable. (If usage is ever absent or
unparseable, the only effect is that a call's token cost is omitted — recorded as the
pre-existing 0/null — never a wrong block.)

## 3. Level-of-abstraction fit

Right layer. Token usage originates in the provider that runs the CLI
(`ClaudeCliIntelligenceProvider`) — the only place it exists — and is surfaced via the
same `IntelligenceOptions` contract every provider already takes. The funnel
(`CircuitBreakingIntelligenceProvider`) is the established single chokepoint that
already records the per-feature metric; threading tokens through it instruments ALL
LLM features at once (Structure > Willpower) rather than each call site. The ledger is
reused unchanged (it already had token columns waiting for data).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface (it is observability: a signal
  producer feeding the metrics ledger).

The metrics ledger is a read-only signal surface (`/metrics/features`); it never gates.
Token accounting strictly adds data; it holds no authority.

## 5. Interactions

- **Shadowing:** none — parsing happens inside `evaluate`'s existing resolve path; no
  new check before/after another.
- **Double-fire:** `onUsage` fires at most once per successful call (only when usage
  is present with non-zero tokens); the funnel composes with (does not clobber) any
  caller-supplied `onUsage`.
- **Races:** none — synchronous parse within the call's own callback.
- **Feedback loops:** none — recorded metrics are read-only; nothing consumes them to
  re-drive an LLM call.

## 6. External surfaces

- **The claude CLI invocation changes** from `--output-format text` to `json`. This is
  the load-bearing risk: the return value is now extracted from `.result`. Mitigation:
  `parseJsonResult` is defensive — non-JSON or missing `.result` falls back to the raw
  trimmed stdout (the prior behavior), so a malformed/partial response degrades to
  "answer without token accounting," never a crash or a JSON blob leaking to callers.
  The empirical CLI shape was verified live (`{ result, usage:{ input_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, output_tokens } }`).
- **Rate-limit detection unaffected:** the circuit breaker's classifier reads
  `stderr`, not stdout — the format switch does not touch it (verified in the provider;
  the error path is unchanged).
- **Other agents / install base:** ships fleet-wide via update; every LLM-backed
  feature's calls now carry token counts into `/metrics/features`. No behavior change
  to what those features decide — only the cost telemetry becomes real.
- **Persistent state:** writes to the existing `FeatureMetricsLedger` SQLite token
  columns (previously always null); no schema change (columns already existed).

## 7. Rollback cost

- **Hot-fix release:** pure code revert shipped as the next patch (revert the three
  core files). No persistent-state migration — the ledger columns simply return to
  null. No agent-state repair, no user-visible regression.
- The only externally-observable change is `claude -p --output-format json`; reverting
  restores `text`. Because `parseJsonResult` already tolerates non-JSON, even a partial
  rollout (some agents on json, some on text) is safe.

## Conclusion

The review produced no design changes — the change is additive, observability-only, and
defensively parsed. The single real risk (the CLI output-format switch) is contained by
the raw-stdout fallback and verified against the live CLI shape. Clear to ship. This is
the sibling of PR A under the same converged + approved spec.

## Second-pass review (if required)

**Reviewer:** the 3 spec convergence reviewers (shared spec) — concur on item 1's
design (additive onUsage side-channel, no evaluate() return-type change). The one
open question they raised — does onUsage fire on cache-only reads — is resolved here:
`parseJsonResult` sums cache_read/cache_creation INTO tokensIn (they are real input
cost) and fires whenever any count is non-zero, so cache-dominated calls are counted,
not dropped.

## Evidence pointers

- `tests/unit/ClaudeCliIntelligenceProvider-jsonParse.test.ts` — parser contract
  (extract .result, sum input components, defensive fallbacks, onUsage firing rules).
- `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` — funnel forwards tokens to
  the recorder, composes with caller onUsage, omits when absent, and sums into the real
  ledger rollup (tokensIn/tokensOut no longer 0).
- Live CLI shape verified: `claude -p --model haiku --output-format json` →
  `{ result:"ok", usage:{ input_tokens:10, output_tokens:41, ... } }`.
- `tsc --noEmit` clean.
