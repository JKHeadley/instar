# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The per-feature LLM metrics now actually collect data. Phase 1a added the ledger
+ `GET /metrics/features`; **Phase 1b adds the funnel tap** — the one shared LLM
call (`CircuitBreakingIntelligenceProvider.evaluate`) now records, per gate/
sentinel, its latency, whether it had to wait out a rate-limit window, and
success/error. So `/metrics/features` goes from empty to live as your checks run.

It's pure observability: a single side-channel `record()` per call, in a
swallow-all try/catch, with the breaker/rate-limit control flow byte-identical.
No gate changes behavior.

## What to Tell Your User

Nothing required. If asked: I can now show real per-check cost and timing, how
often each check runs, and how often it hits a rate-limit wait — the data that
lets us tune the checks with evidence.

## Summary of New Capabilities

- `CircuitBreakingIntelligenceProvider` instruments every LLM call into the
  `FeatureMetricsLedger` via a module-level recorder (`setFeatureMetricsRecorder`),
  wired once in the server so it covers all current and future LLM features.
- Per-feature data: call-count, latency (p50/p95), rate-limit wait-rate, error-rate.
  (Fired-vs-noop verdict + token attribution are Phase 2.)

## Evidence

- Spec: `docs/specs/llm-feature-metrics-spec.md` (Phase 1b; approved Telegram 13435).
- Tests: `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` (+8, incl. an
  end-to-end feed into a real ledger); all 74 existing CircuitBreaking/breaker tests
  pass unchanged; `npm run lint` clean.
