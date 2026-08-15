# R4 Finding — gemini is structurally unusable as a failure-swap target (5s cap < 8.5s p50)

**Date:** 2026-07-01 · anomaly: "gemini 5s swap-timeout poisoning the failover tail."

## Mechanism (from src/core/IntelligenceRouter.ts)
- Provider-fallback-default policy: a *gating* call whose primary provider fails at runtime
  swaps DOWN the active framework chain before failing closed. Each swap attempt is bounded by
  `swapAttemptTimeoutMs` (default **5000ms**), passed to the target as its `timeoutMs` so the
  CLI subprocess SIGTERMs itself at that same bound. "A slow-but-not-erroring provider is
  abandoned at the cap."

## Root cause (R2 data + the cap)
- R2 baseline: **gemini-flash p50 = 8,538ms, p95 = 15,726ms** (uncontended, warm).
- The swap cap (5,000ms) is **below gemini's median response time**. So when gemini is a
  failure-swap target, it is SIGTERM'd at 5s before it can answer on the majority of attempts.
- Net effect: gemini in the swap tail rarely succeeds — it consumes a full 5s swap budget and
  then fails, *delaying* the fall-closed by 5s and never delivering. That is the "poisoning the
  failover tail" symptom: a swap target that reliably wastes its slot.

## Evidence strength: HIGH
- Deterministic: cap (5s, code default) vs measured gemini latency (8.5s p50, N=30). Any swap
  onto gemini has >50% chance of timing out purely from latency, before any load/quota factor.

## Fix options (R6 — reversible/dark)
1. **Raise `swapAttemptTimeoutMs`** to cover a real provider's p95 (~15s for gemini) — but that
   also raises worst-case total swap latency for ALL targets. Prefer a per-provider cap.
2. **Per-target swap cap**: give each framework a cap ≥ its measured p95 (gemini ~16s, pi ~7s,
   claude ~6s). Keeps fast targets snappy, stops killing gemini prematurely.
3. **De-rank gemini in the swap chain** (put faster targets first) so gemini is a last resort,
   not a routine 5s-waster in the tail.
Recommended: (2) per-target cap seeded from this benchmark's p95 table, shipped config-gated.
