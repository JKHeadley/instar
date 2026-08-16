# Side-Effects Review — Threadline §4.2 commit 2: coalesced DRR drain loop

**Version / slug:** `threadline-cooldown-sec4.2-drain-loop`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive lifecycle; opt-in via `onDrainReady` callback; default-off if no consumer wires it)

## Summary of the change

Second commit of §4.2. Adds the shared coalesced drain loop that proactively serves agents whose cooldown has cleared and who have queued messages, replacing the old reactive-only drain (which only fired inside the next inline `evaluate` call from a NEW message — meaning queued messages could sit indefinitely if no follow-up arrived).

Architecture:
- Single shared `setInterval` timer per `SpawnRequestManager` instance, started by `start()`, stopped by `dispose()`.
- Tick interval: `getDrainTickMs() = max(min(cooldownMs / 4, 5000), 1000)` — floor at 1 s prevents hot loops, ceiling at 5 s keeps responsiveness.
- O(1) early return when `pendingMessages.size === 0` so steady-state is essentially free.
- Re-entrancy guard (`#tickInflight`) prevents overlapping tick executions if a slow `onDrainReady` callback runs longer than the interval.
- `unref()` on the timer so it doesn't keep the Node event loop alive past test/CLI exits.

Scheduler: **Deficit Round Robin** with quantum=1, cost=1, at most one drain per agent per tick. Each tick:
1. Collect ready agents (`cooldownRemainingMs <= tickGraceMs` AND `pendingMessages` non-empty).
2. Add quantum to each ready agent's deficit, with 50 % age boost for agents whose drain attempts > 1.
3. Sort ready agents by descending deficit; select up to `maxDrainsPerTick` (default 8).
4. Decrement deficit by cost for each selected agent.
5. Garbage-collect deficit entries for agents no longer ready and at zero.
6. Fire `onDrainReady(agent)` callbacks concurrently via `Promise.allSettled` — one failure does NOT abort the batch.
7. On successful drain, reset that agent's drain-attempt counter (so age-boost only applies to stuck agents).

Public API additions:
- `SpawnRequestManagerConfig.onDrainReady?: (agent) => Promise<void>` — opt-in callback.
- `SpawnRequestManagerConfig.maxDrainsPerTick?: number` — defaults to 8.
- `SpawnRequestManager.start(): void`, `.dispose(): void`, `.runTick(): Promise<number>`, `.getDrainTickMs(): number`, `.getDrrDeficitSnapshotForTests(): ReadonlyMap<string, number>`.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — drain loop constants, state fields (`#drrDeficit`, `#drainAttempts`, `#drainTimer`, `#tickInflight`), config additions, lifecycle + tick methods. `reset()` clears the new state.
- `tests/unit/spawn-request-manager.test.ts` — 11 new tests covering: O(1) early return on no queue, no-op without callback, single ready drain, max-per-tick cap, DRR fairness across consecutive ticks, cooldown-not-cleared skip, lifecycle (start/dispose), idempotent start, dispose clears DRR state, allSettled isolation, tick-interval computation honoring floor/ceiling.

## Decision-point inventory

1. **Callback shape (`onDrainReady(agent) => Promise<void>`).** The simplest contract. The consumer (server wiring, in §4.4) constructs a synthetic `SpawnRequest` from the agent and a peeked queued message and calls back into `evaluate`. Alternatives: emit events (heavier; would need EventEmitter coupling), pass a full `SpawnRequest` (manager doesn't have enough context to construct one — the requester/target/reason live in the consumer's domain).
2. **One drain per agent per tick.** Simplifies DRR (cost=1, quantum=1). For agents with many queued messages, multiple ticks drain them in order, one per tick — consistent with the cooldown semantics: the spawn that handles a queued message itself stamps a fresh cooldown, so the next message for the same agent waits for the next-cooldown's tick anyway.
3. **DRR with sort-by-deficit instead of round-robin index.** Sort cost is O(n log n) per tick where n = ready agents (typically < 100). Round-robin requires a stable cursor across ticks plus careful deletion handling. Sort is simpler and the cost is bounded by `maxDrainsPerTick`.
4. **Garbage-collect deficit only when zero AND not in current ready set.** Prevents the deficit map from growing unboundedly if many distinct peers queue messages over time. Keeping non-zero deficits ensures starved agents stay starved-protected across cooldown cycles.
5. **Re-entrancy guard.** A slow `onDrainReady` callback could run longer than the tick interval; without the guard, multiple ticks could overlap, double-drain, and corrupt deficit accounting. Cheap to add, defensive.
6. **`unref()` the timer.** Prevents the test runner / CLI process from hanging on shutdown if the consumer forgets to call `dispose()`. Defensive type check because some runtimes don't expose `unref`.
7. **`getDrrDeficitSnapshotForTests()` test seam.** Same pattern as §4.1's `getAffinitySnapshotForTests()`. Returns a copy so callers can't mutate state.

## Blast radius

- **Existing callers that don't set `onDrainReady`:** zero behavior change. The drain loop is opt-in. If no callback, `runTick()` short-circuits.
- **Existing callers that don't call `start()`:** zero behavior change. No timer fires.
- **Future callers (server wiring in §4.4):** will set `onDrainReady` + call `start()` at server boot, `dispose()` at shutdown.
- **Tests:** all 33 prior tests pass unmodified; 11 new drain-loop tests added.

## Over-block risk

None — the drain loop only ADDS spawns; it never blocks them. Worst case is a buggy `onDrainReady` that fails repeatedly for one agent, in which case that agent's drain-attempts counter accumulates and eventually the age-boost speeds them through; if the failure is genuinely irrecoverable, the queued messages eventually expire via the `QUEUE_MAX_AGE_MS` (10 min) sweep inside `#queueMessage` / `#drainQueue`.

## Under-block risk

The drain loop fires regardless of penalty state — but the consumer's `onDrainReady` callback typically calls back into `evaluate`, which checks `cooldownRemainingMs` (covering both cooldown AND penalty). So a penalized agent that becomes "ready" by deficit will have `evaluate` deny their spawn anyway. The drain doesn't bypass penalties.

If a consumer wires `onDrainReady` to do something OTHER than call `evaluate` (e.g., a custom batch processor), they're responsible for honoring cooldown + penalty themselves. Documented in the type comment.

## Level-of-abstraction fit

Drain loop lives on `SpawnRequestManager` because the queue, cooldown state, and penalty state all live there. Extracting to a separate `DrainScheduler` class would require passing references to all the private state — net more coupling, not less.

## Signal-vs-authority compliance

The drain loop is a scheduler (signal generator). The authority — whether to actually spawn — stays with the consumer's `onDrainReady` callback (which in the standard wiring delegates to `evaluate`, which is the authority surface). The loop only DECIDES WHEN to ask, not whether to allow.

## Interactions

- **§4.2 commit 1 (state refactor):** drain loop reads `cooldownRemainingMs` (the single read path published by commit 1). Penalty state from commit 1 is honored transitively via the consumer's `evaluate` call.
- **§4.1 (session affinity):** independent. Drain loop processes queued messages; affinity decides which thread the spawned session resumes. Both can be active simultaneously.
- **§4.3 (queue admission):** future commit will add admission caps; the drain loop already respects whatever queue shape exists (it just iterates `#pendingMessages`).
- **§4.4 (config plumbing):** future commit will expose `maxDrainsPerTick` and `cooldownMs` via runtime config + PATCH endpoint. Already wired through the constructor.
- **§4.5 (observability):** future commit will add tick metrics (drains-per-tick, p99 callback duration) and `triggeredBy: 'spawn-request-drain'` tagging.

## Rollback cost

Revert the commit. Public API additions go away. Consumers that registered `onDrainReady` will see a TypeScript error (the field disappears). No data migration needed; no persisted state.

## Tests

- 11 new tests in `describe('§4.2 drain loop', ...)`: O(1) no-queue early return, no-op without callback, single ready drain, max-per-tick cap, DRR fairness, cooldown skip, start/dispose lifecycle, idempotent start, dispose clears DRR state, allSettled isolation, tick-interval bounds.
- All 33 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. Server wiring lives in §4.4 (config + start/dispose at boot). Until then, the drain loop is dormant — no behavior change in production.
