# Side-effects review — UnjustifiedStopGate circuit breaker

**Spec:** `docs/specs/STOPGATE-CLI-CIRCUIT-BREAKER-SPEC.md`
**Change:** a self-circuit-breaker on the stop gate's LLM path so subscription
agents (where a `claude -p` judgment call takes ~5-6s but the budget is ~2s) stop
churning doomed subprocesses and flooding /health with per-stop degradations.
**Class:** robustness fix (found by the 12h session's "load is suspect" investigation).

## What changed

- **`src/core/UnjustifiedStopGate.ts`** — new config `breakerThreshold` (default 3),
  `breakerCooldownMs` (default 5 min), injectable `now`. New `breakerOpen` failure
  kind + `breakerState()` telemetry. `evaluate()` short-circuits (no LLM call) while
  the breaker is open; counts provider failures (timeout/llmUnavailable); resets on
  a reachable provider.
- **`src/core/StopGateDb.ts`** — `InvalidKind` gains `breakerOpen`.
- **`src/server/routes.ts`** — `/internal/stop-gate/evaluate` fail-opens on
  `breakerOpen` (as for any failure) but skips the failure DB record + the
  DegradationReport for it (deliberate short-circuit, not an evaluation failure).

## Blast radius

- **Stop decisions:** unchanged. `breakerOpen` allows the stop exactly like a
  `timeout` fail-open — the breaker can never make a stop decision worse, only the
  fail-open faster + quieter. (This is what keeps the change low-risk despite the
  stop gate being safety-adjacent.)
- **Fast-provider (API-key) agents:** the breaker never opens (calls succeed) →
  identical behaviour to today. Only slow/unavailable-provider agents see the
  short-circuit.
- **Stop-gate analytics:** `breakerOpen` is excluded from the failure rollup (it
  is not an evaluation failure), so the gate's failure-rate metric is no longer
  skewed by the very churn the breaker stops.
- **/health:** stops flooding — at most `breakerThreshold` degradations per
  cooldown window instead of one per stop event.
- **Config / schema / migration:** none. Safe in-code defaults; no PostUpdateMigrator
  entry. Operators may pass `breakerThreshold`/`breakerCooldownMs`/`clientTimeoutMs`
  via the gate constructor if they want to tune it.

## What could break (and why it doesn't)

- **Breaker stuck open forever?** No — it half-opens after the cooldown and a
  single reachable response closes it. A genuinely recovered provider self-heals.
- **A transient blip opens it?** Only after `breakerThreshold` (3) CONSECUTIVE
  failures; a single success in between resets the counter.
- **Lost audit of fail-opens?** Real evaluation failures (timeout, malformed, etc.)
  are still recorded + reported exactly as before; only the deliberate breaker
  short-circuit is excluded.

## Security

No new external input / network / auth / fs surface. Pure in-memory breaker state.

## Rollback

Revert the commit, or set `breakerThreshold: 0` (disables the breaker). No state.

## Tests

`tests/unit/UnjustifiedStopGate-breaker.test.ts` (+5): opens after K + stops
calling the provider; half-open retry after cooldown; reachable-provider reset;
threshold=0 disables; real-timeout counts. Existing gate/route/db suites (42) green.
`tsc` + lint clean.
