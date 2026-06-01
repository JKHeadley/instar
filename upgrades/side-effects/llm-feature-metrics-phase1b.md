# Side-Effects Review — Per-feature LLM metrics, Phase 1b (the funnel tap)

**Slug:** `llm-feature-metrics-phase1b`
**Date:** 2026-06-01
**Author:** echo
**Spec:** `docs/specs/llm-feature-metrics-spec.md` (Phase 1b; approved by Justin, Telegram 13435)

## Summary of the change

Phase 1a (#639) shipped the `FeatureMetricsLedger` + `/metrics/features` but nothing
wrote to it in production. Phase 1b adds the **funnel tap**: the one shared
`CircuitBreakingIntelligenceProvider.evaluate()` now records, per call, the calling
feature + latency + whether a rate-limit bounded-wait was engaged + success/error —
so every LLM-driven gate/sentinel is measured through a single instrumentation point
(built on top of #638's now-merged `evaluate()`, measuring its wait-behavior).

**Files changed (source):**
- `src/core/CircuitBreakingIntelligenceProvider.ts`:
  - new `FeatureMetricsRecorder` **interface** (kept local so core/ never imports
    monitoring/ — no dependency cycle) + module-level recorder + `setFeatureMetricsRecorder()` /
    `getFeatureMetricsRecorder()`.
  - `evaluate()` records on all three exits — success (`noop`), inner failure (`error`),
    and the circuit-open skip (`noop`, marking `waited`) — via a private `recordMetric()`
    that **swallows all errors** (observability must never break the LLM path).
- `src/server/AgentServer.ts`: after constructing the `FeatureMetricsLedger`, call
  `setFeatureMetricsRecorder(this.featureMetricsLedger)` once — a single injection point
  that instruments every wrapped provider (current and future).

**Files changed (tests):**
- `tests/unit/CircuitBreaking-feature-metrics-tap.test.ts` — +8: success→noop, unlabeled
  bucketing, failure→error+rethrow, the rate-limit wait path (`waited`+`waitMs`), the
  circuit-open skip (no inner call, throws `LlmCircuitOpenError`), safe no-op with no
  recorder, a throwing recorder never breaks the call, and an **end-to-end** test feeding
  a real `FeatureMetricsLedger` and asserting the queryable rollup.

## Blast radius

The hot LLM path gains one side-channel `record()` call per `evaluate()`. It is fully
isolated: `recordMetric()` is in a try/catch that swallows everything, and a null
recorder (CLI / no server) is a clean no-op. The breaker/rate-limit control flow is
**byte-identical** to before — all 74 existing CircuitBreaking + breaker-wait tests pass
unchanged. No route, config, or behavior of any gate changes.

## Behavior delta

| Scenario | Before (1a) | After (1b) |
|---|---|---|
| an LLM gate calls `evaluate()` | nothing recorded | one per-feature row (latency, waited, success/error) |
| `/metrics/features` | alive but empty | populated as gates run |
| rate-limit bounded wait (#638) | invisible | recorded (`waited`/`waitMs`) |
| no recorder set (CLI) | n/a | no-op (no record) |
| metrics write throws | n/a | swallowed; LLM call unaffected |
| breaker / rate-limit control flow | as-is | **unchanged** (byte-identical) |

## Outcome semantics (honest scoping)

At the funnel, `outcome` is `noop` for a completed call and `error` for a failure — the
**fired-vs-noop verdict** is the *caller's* interpretation of the result string, not
visible here, and **tokens** live in TokenLedger (the provider returns a string). So
Phase 1b delivers per-feature **call-count, latency (p50/p95), wait-rate, error-rate**;
the verdict + token-join are **Phase 2** (caller-side `recordEvent` / TokenLedger
attribution join). This is stated in the spec and the metric is labeled accordingly.

## Risks considered

- **Dependency cycle (core→monitoring)?** Avoided — the provider depends only on a local
  `FeatureMetricsRecorder` interface; the concrete ledger is injected at runtime.
- **Hot-path safety?** `recordMetric` swallows all errors; an end-to-end + a throwing-recorder
  test prove the LLM path is never broken.
- **Coverage of all providers?** The module-level recorder is read by every
  `CircuitBreakingIntelligenceProvider` instance (all created via the same wrap), so one
  `setFeatureMetricsRecorder()` covers all current and future LLM features — no per-call-site wiring.

## Migration parity

None needed — no agent-installed file changes (no hook/config/skill/CLAUDE.md template).
The `/metrics/features` awareness shipped in Phase 1a (#639); Phase 1b only makes the
existing endpoint produce data.

## Tests / lint

8 new + 74 existing CircuitBreaking/breaker tests pass; `npm run lint` (tsc +
destructive/LLM/URL-log/codex-drift) clean.
