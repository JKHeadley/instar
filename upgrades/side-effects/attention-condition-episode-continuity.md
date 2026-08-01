# Side-Effects Review — Durable Attention condition episodes

**Version / slug:** `attention-condition-episode-continuity`
**Date:** `2026-08-01`
**Author:** `Instar Agent (instar-codey)`

## Summary of the change

Two operator-notice producers previously treated process memory as episode
authority. `StaleOwnerReleaseEngine` keyed ambiguity notices by an in-memory
episode timestamp, and `RopeRecoveryProber` did the same for slow-alive and
exhausted ropes. A server restart erased those maps. If the underlying level was
still unhealthy, the next process opened a fresh episode without observing a
clear, creating duplicate Attention rows.

`AttentionConditionStore` now persists structural identity, active/cleared
state, and an episode counter. Producers own semantic identity and clear
evidence; wiring only provides the shared store. Re-observation while active is
suppressed. Clear followed by recurrence increments the episode.

## Decision-point inventory

- Stale-owner evidence and claim decisions — **pass-through** — unchanged.
- Rope health, probe cadence, exhaustion, and recovery decisions —
  **pass-through** — unchanged.
- Attention episode identity — **modified** — derived from producer, condition
  type, subject, and scope, with durable episode numbering.
- Condition clear — **modified** — only positive producer evidence clears:
  authenticated owner-online/no-live-topic for stale-owner, and
  `lastKnownGood` reclaim for a rope.

## 1. Over-block

The new store never blocks claims, probes, recovery, or user actions. It can
only suppress a second operator notice for a condition already recorded active.

Identity retains the distinctions that matter:

- stale-owner ambiguity and give-up are different condition types;
- per-topic give-ups keep topic scope;
- rope slow-alive and exhaustion are different condition types;
- peer and rope kind remain separate subjects/scopes.

## 2. Under-block

The store is machine-local. Two machines observing the same pool condition can
still create their own rows; pool-wide identity belongs to the broader Attention
condition model and is not claimed here.

Historical duplicate rows are not rewritten. The first post-upgrade observation
creates one store-owned episode alongside legacy rows; later restarts reuse it.

If the state file is unreadable or cannot be written, the producer continues and
the failure is logged. This preserves the safety/liveness paths at the cost of
falling back toward the former duplicate-notice behavior after another restart.

## 3. Level-of-abstraction fit

The producer supplies semantic identity and positive clear evidence. The shared
store, not composition wiring or rendered text, owns episode numbering. This is
the same structural boundary required for the eventual condition-oriented
Attention chokepoint, without migrating unrelated emitters in this patch.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No block/allow or actuation authority is added.

The store is idempotency and lifecycle bookkeeping for an existing signal. It
cannot make an owner stale, declare a rope dead, claim a topic, or send a probe.

## 4b. Judgment-point check

No heuristic decides whether two rendered messages look similar. Identity is an
enumerated tuple authored at the branch that knows the condition, and clears are
existing positive runtime facts. No LLM or competing-signal judgment is added.

## 5. Interactions

- **Shadowing:** The Attention store still owns row creation and exact-ID
  idempotence. `AttentionConditionStore` owns the earlier question of whether a
  new semantic episode exists.
- **Double-fire:** The lifecycle record is persisted before the existing raise
  callback runs, so a synchronous restart cannot mint another episode.
- **Races:** The server single-instance guard leaves one local writer. Atomic
  rename prevents torn state reads after a crash.
- **Feedback loops:** Condition state does not feed stale-owner evidence, claim
  annotations, resolver health, or probe scheduling.

## 6. External surfaces

The user-visible effect is fewer duplicate queue rows after upgrades and server
restarts. A genuine clear-and-recur remains visible under a new `ep-N` item ID.
No endpoint, permission, secret, dependency, or configuration surface changes.

## 6b. Operator-surface quality

No dashboard or form changes. Existing Attention rows, statuses, and actions
remain compatible.

## 7. Multi-machine posture

The lifecycle file is local because the two producer instances and their source
evidence are local. The condition tuple includes machine/peer subjects where
appropriate. Pool-wide coalescing is explicitly not claimed.

The file is bounded to 2,000 records; inactive oldest records are pruned first.
Active records are never pruned to satisfy the cap, because forgetting an active
condition recreates the exact restart-duplication defect. If all 2,000 records
are active, a new condition uses a deterministic capacity-degraded ID without
entering the file; exact-ID Attention dedupe still bounds restart repetition,
and the loss of recurrence counting is logged.

## 8. Rollback cost

Rollback is code-only. The new JSON file becomes inert and can remain on disk;
older versions do not read it. Existing Attention rows remain ordinary rows.

## Conclusion

The fix changes the false boundary directly: a process restart is no longer an
Attention episode transition. Recovery evidence, not process incarnation, is
what permits recurrence.

## Evidence pointers

- Focused unit suite: 54 passing.
- Repository lint suite: passing.
- TypeScript build: passing.

## Class-Closure Declaration

No prompt, hook, skill, config, or standards artifact is fixed. The change is a
runtime lifecycle correction in two existing deterministic producers.
