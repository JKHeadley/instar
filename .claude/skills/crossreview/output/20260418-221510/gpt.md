# GPT 5.4 Review: THREADLINE-COOLDOWN-QUEUE-DRAIN-SPEC.md

**Model**: gpt-5.4
**Date**: 2026-04-18
**Focus**: full document
**Score**: 8/10 CONDITIONAL
**Note**: Write permission to this output path was blocked from the subagent sandbox. This summary captured by the orchestrator.

---

## Critical Findings (6)

1. **Queue persistence/rehydration ownership ambiguous** across SpawnRequestManager + messageStore + DeliveryRetryManager. Highest-risk integration point. Wants an explicit lifecycle state machine with owner for each transition.

2. **Weighted shuffle `max(drainAttempts, ageMs)` compares incomparable scales.** drainAttempts is 0–3; ageMs is in milliseconds (thousands to millions). The `max` is dominated by age in every realistic case, rendering drainAttempts a no-op. Replace with Deficit Round Robin (DRR) or round-robin + explicit age boost.

3. **Phase-1 regex error classifier too brittle.** Matching on `err.message` is fragile across library upgrades. Restrict `agent-attributable` classification to locally-generated *typed* errors only; everything else (including regex-matched messages from deep libraries) stays `ambiguous` in Phase 1. Defer attribution precision to Phase 2.

4. **Kill-switch nonce binds queue-state hash + tokenHash but NOT the requested config payload.** An attacker with the nonce could confirm a different config than the dry-run showed. Add canonical PATCH-body hash to the nonce binding.

5. **Plaintext timing-pad lacks operational telemetry.** Padded vs unpadded refusal counts, concurrency-cap breaches, and alert thresholds are not specified. Operators will not notice when the pad is being bypassed under flood.

6. **Affinity invalidation lifecycle missing for normal session end / eviction / crash / transfer.** The spec specifies TTL-based eviction but not how affinity maps react to legitimate session-end events, LRU evictions, process crashes, or session-transfer flows.

## Notable Gaps

- No end-to-end message lifecycle diagram.
- No idempotency contract on redelivery after `undelivered` marking.
- No crash-window analysis (what messages can be lost and under what conditions).
- All time arithmetic uses `Date.now()`; no discussion of monotonic time (`process.hrtime()`) for intervals that should be immune to wall-clock adjustments.
- Canonical-JSON serializer rules under-specified (recursion, arrays, null, undefined handling).
- GET /threadline/spawn-status missing auth, error, and pagination specification.
- Bounded-map resource-budget estimates missing (memory at `SPAWN_STATE_MAX = 10_000`).
- "Degraded admission" semantics (1-slot admission for 30 min) under-specified: does it affect drain priority? Recovery path from degraded to normal?

## Top 5 Prioritized Recommendations

1. Explicit end-to-end message state machine + ownership model (most important).
2. Replace weighted shuffle with a known scheduling algorithm (DRR or round-robin + age boost).
3. Constrain Phase-1 attribution to locally-generated typed errors only.
4. Strengthen kill-switch nonce binding to include canonical PATCH payload hash.
5. First-class operational metrics (padded/unpadded counts, cap breaches, drain latencies), not just breadcrumbs.

## Subagent Analysis

Substantive review. GPT focused strongly on lifecycle/ownership ambiguity — a higher-level concern than the Claude-family reviewers flagged. The weighted-shuffle scale-mismatch finding is a real defect that all 4 internal Claude reviewers missed across 6 rounds. Regex-classifier brittleness is a genuine concern with the Phase-1 fallback.
