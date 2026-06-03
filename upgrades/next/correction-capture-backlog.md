# Upgrade Guide — correction capture-backlog with retry

<!-- bump: minor -->

## What Changed

The Correction & Preference Learning Sentinel now survives an LLM throttle without losing corrections.

Previously, the capture hop distilled each detected correction through a rate-limited LLM queue behind the account-global circuit breaker. When that distill call was rejected for a capacity reason — daily spend cap reached, interactive-reserve breach, an aborted background call, or the breaker being open — `CorrectionCaptureLoop` dropped the capture silently with no retry and no backlog. On a production agent under sustained throttling that meant Layer 0 kept *detecting* corrections while the `CorrectionLedger` stayed permanently EMPTY, because every distill attempt hit the breaker and was discarded.

This release adds `CorrectionCaptureBacklog` — a bounded, durable SQLite store at `correction-capture-backlog.db`. When a distill is rejected for a capacity reason, the already-pre-scrubbed capture is PERSISTED to the backlog instead of dropped. A new `isCapacityThrow` classifier distinguishes a capacity rejection (worth retrying later) from a genuine fault (a malformed envelope still drops, preserving the old behavior). A new audit decision `distill-backlogged` records the persist.

A new `drainBacklog` function works the backlog down off the message hot path. It is triggered two ways: opportunistically right after a live capture's distill SUCCEEDS (proof the LLM has headroom *now*), and by a slow 5-minute periodic sweep. The drainer is breaker-gated — it consults `llmCircuitAvailable()` (a pure, non-probe-consuming read) and never drains while the breaker is open, since that would just re-fail every entry and re-trip the circuit. For each claimed entry it rebuilds the same distill prompt, records a real learning into the `CorrectionLedger`, then DELETES the backlog row (`markDistilled`); a failed attempt calls `bumpAttempt`, which drops the entry once it exceeds its retry budget.

Retention is bounded two ways: a max-entries cap (oldest evicted on overflow) and a TTL (stale entries pruned before each drain). The store persists ONLY the pre-scrubbed turns — the same secret scrub that guards the distill prompt runs before anything is written, plus a defensive re-scrub on enqueue — and no API route ever serves backlog contents. It is on by default whenever the feature is enabled (pure resilience) and is disabled by setting its max-entries to zero, which restores the old drop-on-throttle behavior. All four new dials backfill into existing agents via `applyDefaults` deep-merge.

The whole path is fail-open and signal-only: a backlog or drain error can never block, delay, or throw into message delivery.

## What to Tell Your User

- **Corrections survive a busy stretch now**: "When you correct me about the same thing and I happen to be rate-limited at that moment, I no longer just lose it. I tuck the correction away safely and learn from it a little later once I have headroom — so a busy period can't make me quietly forget what you taught me. It only ever keeps a private, scrubbed note of the lesson, never your raw words, and it tidies those away as soon as they're learned. This whole thing only runs when correction learning is switched on, and I can turn it off for you if you ever want the old behavior back."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Durable retry of throttled corrections | Automatic when correction learning is enabled |
| Disable the backlog (old drop behavior) | Set the correction-learning capture-backlog max-entries to 0 |
| See learned corrections (the ledger the backlog feeds) | GET /corrections |

## Evidence

- **Reported live**: on a production agent with correction learning enabled, Layer 0 was detecting corrections but GET /corrections returned an empty ledger. Root cause confirmed in `src/monitoring/CorrectionCaptureLoop.ts` (~line 204): the distill catch block dropped every capture on any LlmQueue throw, and the agent's account was sustained-throttled, so every distill hit the open circuit breaker and was discarded.
- **After (code path), full round-trip proven**: `tests/e2e/correction-capture-backlog-lifecycle.test.ts` drives a learning-signal capture whose distill is rate-limited → asserts decision `distill-backlogged` and a backlog count of 1 (NOT dropped); asserts the drain is SKIPPED while the breaker is open (entry retained); then flips the breaker closed, drains, and asserts the distilled record is recorded into the ledger, the backlog row is deleted, and the record is observable on the real GET /corrections route with only its scrubbed summary served (raw learning never crosses HTTP).
- **Unit coverage**: `tests/unit/CorrectionCaptureBacklog.test.ts` (11 cases: enqueue, max-entries eviction oldest-first, near-identical dedupe, claimBatch ordering + min-retry-gap, markDistilled, bumpAttempt-drops-at-maxRetries, TTL prune, pre-scrubbed-only persistence, fail-open). `tests/unit/CorrectionCaptureBacklog-drain.test.ts` (12 cases: the four-shape isCapacityThrow classifier, capacity-throw → backlog vs non-capacity → drop, no-backlog-wired old drop, backlog-fault fallback, drain breaker-gated/recorded/bumped/pruned/fail-open). Wiring-integrity in `tests/unit/correction-learning-wiring-integrity.test.ts` (backlog constructed iff enabled+maxEntries>0; a rate-limited capture lands in the backlog without throwing into the hook; drain skipped while breaker open). Integration round-trip in `tests/integration/corrections-routes.test.ts`. All green: 11 + 12 + 9 + 13 + 2 = the new/updated suites pass with zero failures.
