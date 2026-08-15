# R4 Finding — "codex errors with 99% quota free" = 30s timeout < codex cold/wedge latency

**Date:** 2026-07-01 · anomaly: codex erroring while quota is nearly full.

## Evidence chain
1. **Quota is NOT the cause.** Live check: codex primary 96% remaining, secondary 98%
   remaining, `rateLimitReachedType: None`, plan pro. Codex errors occur with quota free.
2. **codex latency exceeds the internal timeout.** instar's `CodexCliIntelligenceProvider`
   uses `DEFAULT_TIMEOUT_MS = 30_000` (30s) for internal calls (sentinels/gates/extractors).
   Measured codex latency (this project):
   - warm: ~18s (under 30s — succeeds)
   - COLD start: ~40–61s (R1b) — EXCEEDS 30s → timeout
   - wedge tail: 5+ minutes (R4-codex-wedge) — always times out
3. **A timeout is recorded as an error / trips the breaker.** The 30s-capped call is killed,
   the failure is classified and counted by the circuit breaker — indistinguishable, in the
   error count, from a "real" provider error, even though quota was fine.

## Root cause
Codex's cold-start + heavy tail routinely exceed the 30s internal-call timeout. Any codex call
that isn't warm (the first after idle, or a wedged one) times out → an "error" that has nothing
to do with quota. On a chatty agent whose codex process is often cold between bursts, this
produces frequent "codex errored" events sitting on top of ~full quota.

## Confidence: HIGH (mechanism) / corroboration pending
- Mechanism is deterministic (30s cap vs measured 40–61s cold). The R2 codex baseline (running)
  will quantify the real cold-vs-warm split and timeout rate at N=30 to put a number on it.

## Fix options (R6 — reversible/config-gated)
1. **Raise the codex internal timeout** to cover cold-start (e.g. 60–90s) so a cold codex call
   isn't a false error. Trade-off: a genuinely wedged call now ties up a slot longer — pair
   with the process-tree kill (already the right pattern) and a wedge ceiling.
2. **Keep codex warm** for latency-sensitive components (a warm pool / keep-alive) so calls
   stay in the ~18s band, under any reasonable cap.
3. **Route latency-sensitive GATING calls off codex** (to pi ~4.6s or claude ~3s) and reserve
   codex for latency-tolerant background/batch work. Aligns with the R2 token-overhead finding
   (pi is both faster AND ~10x leaner per call than codex) and the provider-fallback policy.
Recommended: (3) for gating + (1) raise the cap for the rest; both reversible/config-gated.
