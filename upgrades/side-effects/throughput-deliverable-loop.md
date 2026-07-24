# Side-Effects Review — Live throughput deliverable loop

**Version / slug:** `throughput-deliverable-loop`  
**Date:** `2026-07-21`  
**Author:** `instar-codey`  
**Second-pass reviewer:** `not required`

## Summary of the change

`BlockerLifecycleService` now schedules the next bounded 64-commitment reconciliation slice immediately until a complete sweep, then restores the existing five-minute cadence. The schema-v2 trend adds live window, current-day, and cumulative completion counts. `server/routes.ts` validates every relayed live row and recomputes its arithmetic. Tests prove a delivered commitment beyond the first slice appears promptly and that real delivery events make the reading climb.

## Decision-point inventory

- Reconciliation scheduling — modify — chooses zero-delay continuation after an incomplete successful slice and the existing five-minute delay after a complete successful sweep.
- Pool response structural validation — modify — rejects malformed or arithmetically inconsistent peer metric data at the existing trust boundary.
- Commitment delivery authority — pass-through — remains exclusively owned by `CommitmentTracker.deliver()`.

## 1. Over-block

The only rejection surface is schema validation for peer trend responses. A schema-v2 peer that sends a cumulative series with a skipped/duplicated date, inconsistent running total, incorrect complete flag, or final count different from `currentDayCount` is rejected as `invalid-body`. Those shapes cannot truthfully represent the declared schema. Local commitment delivery is never rejected or delayed by this metric path.

## 2. Under-block

The metric still cannot infer real-world completion when no concrete commitment was registered and delivered; doing so would be dishonest. A SQLite failure can delay visibility until reconciliation succeeds, and an origin that has not upgraded remains explicitly unsupported. These are surfaced degradation states, not invented zeroes.

## 3. Level-of-abstraction fit

The fix stays at the existing derived-metric layer. `CommitmentTracker` remains the durable delivery authority, `BlockerLifecycleLedger` remains the sole measure-only store, and `BlockerLifecycleService` remains the event consumer/reconciler. No higher-level drive, session, git, or chat heuristic was added and no lower-level storage primitive was duplicated.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over user or agent behavior.

Completion counts are observations. They cannot choose work, rank people, impose a target, notify, grade, block a merge, gate a route, or mutate a commitment. Peer structural validation is a hard schema invariant at an authenticated boundary, explicitly allowed by the principle; it does not judge meaning or intent.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. The only deterministic choices are enumerable invariants: bounded slice completion, consecutive UTC dates, nonnegative integer counts, and exact cumulative arithmetic.

## 5. Interactions

- **Shadowing:** no new producer shadows delivery; both live events and reconciliation use the same opaque completion identity and ledger unique key.
- **Double-fire:** a live event and a reconciliation pass may both attempt the same row, but existing idempotent dedupe admits it once.
- **Races:** each pass still processes at most 64 commitments synchronously. A zero-delay timer yields to the event loop before the next slice. Close clears the scheduled timer through the existing service lifecycle.
- **Feedback loops:** no metric consumer feeds back into commitment delivery or reconciliation scheduling.

## 6. External surfaces

The authenticated `/blocker-lifecycle/trend` schema-v2 response gains additive `windowTotal`, `currentDayCount`, and `cumulativeDays` fields. Existing `days`, ratio, and direction retain complete-day semantics. No new external call, notice, endpoint, table, identifier, prose field, or operator action is introduced. Timing changes only during successful incomplete reconciliation sweeps.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read.** Each origin's ledger remains machine-local because it measures that origin's authoritative commitments. The existing `?scope=pool` read returns per-origin values through authenticated bounded proxying, and the modified sanitizer validates the additive fields before exposure. No fleet aggregate is invented. The change emits no user-facing notices, creates no URLs, and does not strand commitment state on topic transfer because mutations continue to route to the commitment origin.

## 8. Rollback cost

A hot-fix can revert the scheduling and additive response fields. No data migration or agent-state repair is required: existing commitment records and ledger rows stay valid and inert. During rollback propagation, upgraded readers may temporarily classify an older peer response as unsupported, which is the existing mixed-version behavior.

## Conclusion

The review kept the fix inside the existing commitment-to-ledger loop, retained bounded event-loop work and failure brakes, preserved complete-day trend meaning, and tightened cross-machine semantic validation. It introduces no new behavioral authority or parallel state owner and is clear to ship.

## Second-pass review

Not required: this change does not touch messaging, dispatch, session lifecycle, context recovery, trust, a sentinel, a guard, a gate, or a watchdog.

## Evidence pointers

- `tests/unit/BlockerLifecycleService-throughput.test.ts` proves live 0 → 1 → 2 movement.
- `tests/integration/blocker-throughput-reconciliation.test.ts` proves prompt second-slice recovery and restart idempotency.
- `tests/integration/blocker-throughput-pool-routes.test.ts` proves hostile cumulative arithmetic is rejected.
- `tests/e2e/blocker-throughput-count-alive.test.ts` proves real-server route output.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered action controller — not applicable. Reconciliation is a measure-only derived-state repair loop and never restarts, swaps, respawns, spawns, notifies, re-drives external work, kills, or otherwise acts on the agent.
