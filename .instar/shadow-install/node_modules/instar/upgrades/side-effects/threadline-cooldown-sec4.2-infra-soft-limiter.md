# Side-Effects Review — Threadline §4.2 commit 3: infra-failure soft limiter

**Version / slug:** `threadline-cooldown-sec4.2-infra-soft-limiter`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive backpressure; no penalty surface; only effect is a smaller queue cap for peers reliably triggering infra failures)

## Summary of the change

Third and final commit of §4.2. Adds an infra-failure soft limiter as the second axis of failure handling — orthogonal to the agent-attributable penalty system from commit 1. Where penalty SILENCES a misbehaving peer, the soft limiter gently SLOWS DOWN a peer that reliably trips infrastructure failures (provider 5xx, gate LLM timeout, memory pressure, etc.) — without blame.

Mechanics:
- Each infra-attributable (or ambiguous) failure records a timestamp in `#infraFailureWindow: Map<agent, number[]>`.
- Window: 10 minutes. Threshold: 5 failures within window.
- When threshold tripped, agent enters degraded admission for 30 minutes (counted from the threshold-tripping failure, not from now).
- Degraded admission caps queue depth at `degradedMaxQueuedPerAgent` (default 1, configurable).
- Status read via public `isInfraDegraded(agent)` and `effectiveMaxQueuedPerAgent(agent)`.
- No effect on cooldown, no penalty, no escalation. Just a smaller bucket.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — constants, `#infraFailureWindow` field, `degradedMaxQueuedPerAgent` config, `#recordInfraFailure`, `isInfraDegraded`, `effectiveMaxQueuedPerAgent` helpers; `#applyFailureAttribution` extended to feed the window for non-attributable causes; `#queueMessage` now consults `effectiveMaxQueuedPerAgent`; `reset()` clears the window.
- `tests/unit/spawn-request-manager.test.ts` — 5 new tests covering: 5-failure trigger, window slide-out, agent-attributable failures don't count, 30-min degradation expiry, custom override.

## Decision-point inventory

1. **Ambiguous causes feed the window.** Per spec, ambiguous = unknown classification, which from the limiter's perspective is functionally indistinguishable from infra. The signal is "this peer reliably correlates with things going wrong, but we can't blame them." Including ambiguous gives the limiter useful early signal instead of waiting for confirmed infra labels.
2. **Window stored as a plain `number[]`, not a CircularBuffer class.** Spec says "CircularBuffer". A trimmed array is functionally identical for this size (≤ 5 entries kept; pruning is O(n) with n≤5). Adding a class for this would be over-engineering. If pressure shows up in profiling, swap to a true ring buffer.
3. **Degradation-window timing.** Counted from the threshold-tripping failure (the Nth-most-recent), not from "now". So a peer that fails 5 times in quick succession is degraded for the next 30 min, not 30 min after their LAST failure (which would let them refresh the timer indefinitely).
4. **Default degraded cap = 1.** Most aggressive useful value: peer can have at most 1 message queued at a time. Configurable for environments that want softer treatment.
5. **No DegradationReporter breadcrumb wired in this commit.** Spec mentions "spawn-infra-degraded" breadcrumb. DegradationReporter integration belongs in §4.5 observability — keeping this commit focused. The behavior (cap on queue) is the load-bearing part.
6. **Helper exposed publicly.** `isInfraDegraded` is part of the public surface so consumers (and the future server config endpoint) can query degradation state for status displays / dashboards.

## Blast radius

- **Existing callers:** zero behavior change unless their `spawnSession` throws `SpawnFailureError` with infra causes. Today no caller uses `SpawnFailureError`, so degradation never triggers in production until adoption begins.
- **Future callers wrapping `spawnSession`:** if they tag failures with `provider-5xx`, `gate-llm-timeout`, etc., they get the soft limiter. Opt-in via classification.
- **Queue depth for normal traffic:** unchanged (cap stays at MAX_QUEUED_PER_AGENT = 10 unless degraded).
- **Penalty system:** unaffected. Soft limiter is a parallel axis.

## Over-block risk

A peer with intermittent infra issues that happen to hit 5-in-10-min could be capped to 1 queued message for 30 min. That's the intended behavior, but if it's tuned too tight in practice we may need to relax the threshold. Tuning is data-driven; can be revisited.

## Under-block risk

The threshold (5 in 10 min) is from the spec. A pathological peer that triggers exactly 4 infra failures every 9 min would never trip degradation. Acceptable: the goal is to slow down peers that are noticeably failing, not to chase every edge case.

## Level-of-abstraction fit

Soft limiter sits next to penalty state in `SpawnRequestManager`, which is the right level — both axes consume the failure stream and both affect spawn admission. Extracting to a separate class would just move state references around.

## Signal-vs-authority compliance

The limiter computes a signal (`isInfraDegraded`) and applies a structural constraint (`effectiveMaxQueuedPerAgent`). Authority — whether to actually accept the message — still lives in `#queueMessage`'s subsequent shift-when-over-cap logic. Compliant.

## Interactions

- **§4.2 commit 1 (penalty):** orthogonal. A peer can be penalized AND degraded simultaneously — penalty stops them from spawning, degradation caps their queue.
- **§4.2 commit 2 (drain loop):** the drain loop reads `#pendingMessages` directly. If a degraded peer's queue is capped at 1, the drain loop sees at most 1 pending entry per tick for them — same iteration semantics, just a smaller scan.
- **§4.5 (observability):** future commit will add `spawn-infra-degraded` DegradationReporter breadcrumb. The structural detection lives here; the reporting goes there.
- **§4.4 (config):** future commit will expose `degradedMaxQueuedPerAgent` via runtime PATCH. Already wired through the constructor.

## Rollback cost

Revert the commit. `effectiveMaxQueuedPerAgent` falls back to the static cap. `isInfraDegraded` disappears (consumers must update). No persisted state.

## Tests

- 5 new tests in `describe('§4.2 drain loop', ...)` (under the same group): trigger after 5 infra failures, window slide-out, agent-attributable doesn't count, 30-min expiry, custom override.
- All 44 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. §4.2 is now complete. Next: §4.3 queue shape + admission + truncation marker, then §4.4 config plumbing, then §4.5 observability.
