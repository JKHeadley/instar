# Side-Effects Review — Trustworthy machine load, P3 (moving existing work off an overloaded machine)

**Version / slug:** `trustworthy-machine-load-p3`
**Date:** `2026-10-26`
**Author:** `echo`
**Second-pass reviewer:** `reviewer subagent (independent read, appended below)`
**Tier:** 2 (spec-driven; `docs/specs/trustworthy-machine-load-and-mesh-floor.md` Part D + C3, converged over 3 cross-model rounds, approved by Justin 2026-10-25 14:19 PDT). Size: 2 new source files (`OverloadShedPlanner.ts`, `sessionPriority.ts`), 6 modified source files (reconciler, rebalance planner, stale-owner engine, server wiring, route, governor policy) + template/migrator/manifest/registry entries + 5 test files. Effort: 0 further spec rounds, second-pass rounds below, in proportion for a Tier-2 phase that ships dry-run.

## Summary of the change

Phase 3 of the spec. (D1) `OverloadShedPlanner` is a proposer: every 15 s it decides whether THIS machine should shed and, if so, hands the `OwnershipReconciler` one transient entry through a new `overloadMoves()` dep. The reconciler processes it after the pin loop, at lower precedence (a topic seen in the pin loop is skipped), through its existing `transfer` CAS; nothing is written to the pin store. The target comes from `planRebalance` + `PlacementExecutor.decide`; `planRebalance` now threads the session's channel scope (CMT-1568) and takes `isSource` / `targetEligible` overrides. (D2) Source = own admission closed continuously ≥3 min. Target = `liveness.state==='live'` with evidence ≤2 min, `loadVerdict==='ok'`, not refusing, not seen refusing in 30 min, ≥2 free slots after local reservations. Only Telegram topic keys move; pinned and live-autonomous topics never. (D3) One live entry at a time (held while its transfer is in flight), 2 moves/hour breaker checked before proposing, 2 tries per topic per durable overload episode (plus at most 2 refunds for proposals whose transfer never started), busy topics never proposed, the reconciler initiating at most one overload transfer per topic per episode, 30-min topic cooldown, governor class `overload-shed` (observe-only), audit `logs/overload-shed.jsonl`. (D4) Durable reservations with TTL in `state/overload-shed.json`; a new reconciler dep `driveUnpinnedTransfers()` (live only with overloadShed enabled AND `dryRun:false`) scans the registry for unpinned `transferring` records: the target claims (after the drain grace), the source aborts past `transferDeadlineMs` regardless of target liveness; a target that is itself refusing work (enforced) does not claim. (D5) Stale-owner ambiguity notices describe the owner from its honest liveness ("struggling", "refusing connections", "still answers"), display only. (C3, carried from P2) `SessionPriorityLowerer` renices each session's pane process group to 5 once, only while admission is enforced. Dev-gated (`monitoring.overloadShed`) and dry-run first.

## Decision-point inventory

- `OwnershipReconciler.tick()` — **modify (new move source)**: overload transfers after pins; unpinned transfer driving. Both inert unless their deps are supplied (`overloadMoves` absent ⇒ none; `driveUnpinnedTransfers` absent/false ⇒ pin-only, today's behaviour). Every action still goes through `act()`, so the reconciler's own `ws13DryRun` keeps it to a logged intent.
- `OverloadShedPlanner.tick()` — **add**: the proposal authority; deterministic; dry-run first; also inert while admission is not enforced.
- `planRebalance()` — **modify**: channel threading (a filter that can only REMOVE candidates) and two optional overrides; absent overrides ⇒ byte-identical behaviour. It had no production caller before this change.
- `StaleOwnerReleaseEngine` ambiguity notice — **modify (wording only)**: `describeOwner()`; no evidence or claim decision changes.
- `SessionPriorityLowerer` — **add**: lowers priority of session process groups while admission is enforced.

---

## 1. Over-block

- Nothing is refused by this change. The closest thing is a topic being moved off the machine it was on: a move needs the machine's own admission closed for 3 minutes (2 of 3 samples overloaded each 15 s, so a sustained overload, not a spike), an idle topic (the reconciler's busy gate, no deadline override), and a healthy target on fresh evidence. A move the target never claims is aborted back after the transfer deadline; the topic is then left alone after 2 tries per episode.
- C3: sessions lose scheduling priority only while admission is ENFORCED; at nice 5 they still get all idle CPU. A session that legitimately needs full priority under contention runs a little slower — the trade the spec asks for (the server and lifeline must stay schedulable).

## 2. Under-block

- Slack conversations are not shed in this version (their workspace scope is not on the ownership record, so a target that cannot reach the workspace could be chosen). They stay where they are — today's behaviour. Telegram's shared chat is served by every machine, so the router already places Telegram topics without a channel scope.
- Reservations are local to the proposing machine. Two overloaded machines can pick the same target in the same window; each still moves at most one topic at a time and the target needs ≥2 free slots, so the overshoot is bounded at one extra session per source. A shared reservation would need a cross-machine write path this phase does not add (spec D4 asks for durable per-episode reservations; they are durable, not shared — named here).
- "A machine that shed work cannot receive moved work for 30 min" is enforced from what THIS machine observed (a peer seen refusing work); a shedding machine is by construction refusing work, so the observation covers it whenever the two machines exchanged a report in that window.
- The planner moves at most 2 topics an hour off a machine; a deep overload is relieved slowly. That is the spec's cascade guard, by design.

## 3. Level-of-abstraction fit

Right layers. The move itself reuses the reconciler's cooperative-transfer CAS and its existing gates (target sustained-online, busy topic, live autonomous run, pacing), so an overload move and a pin move share one actuator and one exactly-one-owner invariant. Target choice reuses `PlacementExecutor.decide` (the router's own scorer, incl. the refusing-machine filter from P2) through the previously unused `RebalancePlanner`, and the self-action brake is the shared governor. The planner only owns what is specific to overload: the source rule, the target rule, and the brakes. `TransferOrchestrator` is deliberately not used (spec D1). C3 renices after spawn instead of editing four framework spawn argvs that are pinned by tests.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — this change adds authority (it initiates ownership transfers of live conversations). It is admissible because: (a) the input is not a single brittle check — the source rule rides P2's admission state, itself the multi-signal 2-of-3 verdict, held for 3 minutes; the target rule needs fresh direct evidence, a healthy verdict and headroom; (b) the action is reversible and cooperative — a transfer the target does not claim is aborted back to the source, and the conversation's transcript and durable state follow the topic as for any move; (c) every move is bounded (one at a time, 2/hour, 2 tries per topic per episode) and governed; (d) it ships dry-run, and is additionally inert until admission itself is enforced. Pinned topics (an operator choice) and live autonomous runs (which need the operator's consent to move) are never touched — the human choice always wins.
- The reconciler's unpinned-transfer driving IS new authority over every unpinned in-flight transfer (overload moves, drain-runner transfers, MeshRpc `transfer` commands, a pinned record temporarily left out of the effective pin list): the target claims it, and the source aborts it past the deadline even when the target is alive (the pinned N4 path only aborts toward an offline target). It is admissible because a transfer that has not been claimed by the deadline is not progressing, and abort returns the topic to its current, working owner; but it is held behind BOTH the overloadShed gate and `dryRun:false`, so the soft lever holds it, and a target that is itself refusing work (enforced) does not claim.
- C3 is a scheduling-priority change, not a gate.

## 4b. Judgment-point check (Judgment Within Floors standard)

The source/target rules are static thresholds over measured state. Floors: never move a pinned or autonomous topic, never move a busy topic, never move to a machine without fresh healthy evidence, never more than 2/hour. The arbiter for wrong thresholds is the dry-run `would-move` record (read before the flip) and the governor's observe-only counters. Operator levers: `monitoring.overloadShed.dryRun:true` (soft, read live: the planner proposes nothing and the reconciler's unpinned driving is off) and `enabled:false` (kill switch, read live by the planner and by the unpinned driving each tick).

## 5. Interactions

- **Pins:** the overload loop runs after the pin loop and skips every topic the pin loop saw (`pinnedSeenThisTick`) and every topic with a local or replicated preferred machine (server `shedPinned`); an unreadable pin view counts as pinned.
- **Pacing:** overload transfers count toward the same `maxMovesPerTick` as pin moves; a pin move is always considered first.
- **Stale-owner release:** unchanged. An unreachable SOURCE is handled by stale-owner release (spec D4); an unreachable TARGET is aborted by the source past the deadline (now also for unpinned records).
- **Closeout reaper:** after a claim the existing post-transfer closeout closes the old machine's session for the topic (unchanged path).
- **Placement:** a machine shedding work also refuses new work (P2), so placement does not send moved topics back to it; the target filter excludes machines seen refusing in the last 30 min.
- **Restart mid-move:** the live entry, reservations, breaker and episode are durable; the reconciler drives the in-flight `transferring` record to claim or abort independently of the planner.
- **Self-action governor:** observe-only class `overload-shed`; an enforce-mode hold becomes an audited `governor-held` (no move).
- **Moves that do not land:** the reconciler initiates at most ONE overload transfer per topic per episode (an in-memory actuator latch); an unclaimed transfer is aborted back once and not re-initiated. The planner sees the transfer start (`statusOf`), never hands the entry out again, holds its one-at-a-time slot and reservation while the transfer is in flight, and records `aborted` when it comes back. A proposal whose transfer never started (deferred by the reconciler) is refunded at most twice per topic per episode. Busy topics are not proposed.
- **Restart:** the actuator latch is in memory; after a restart a still-live proposal could be transferred once more (bounded by restarts and by the entry TTL). The planner's episode, attempts and refunds are durable.
- **C3 × watchdog/reaper:** a lower-priority session is scheduled less under contention; CPU-time-based judges (the test-runner floor's subtree CPU check) still see CPU advancing, just more slowly. The lowerer never renices the server or lifeline (only listed session panes). Limit: processes already running in their OWN process group when admission becomes enforced (detached workers, subprocesses that called setsid) are not lowered; only the pane's group and what it forks afterwards. A failed renice is not retried for that pane.

## 6. External surfaces

- Mesh: no new RPC or report field. A move is the existing `transfer` → `claim` journal exchange.
- User-facing: none new in dry-run. When live, a moved conversation continues on another machine through the existing handoff (as for any pin move).
- Config: `monitoring.overloadShed` (new, omitted by default). Files: `logs/overload-shed.jsonl`, `state/overload-shed.json` (both registered).
- Route: `GET /overload-shed` (Bearer, read-only); `GET /work-admission` gains `sessionPriority`.

## 7. Multi-machine posture (Cross-Machine Coherence)

The planner's state is **machine-local by design**: each machine decides only about topics IT owns (only the live owner sheds; the reconciler re-checks owner===self). The move is carried by the existing replicated ownership journal (`transferring` → `claim`), so exactly-one-owner holds across machines through the same CAS + epoch fencing as pin moves. Reservations are local (named in §2). The status route reports this machine only; `GET /pool` already shows each machine's admission state. Unpinned transfer driving is per-machine and symmetric: the target claims, the source aborts.

## 8. Rollback cost

Config: `monitoring.overloadShed.dryRun:true` (soft, live: no proposals, unpinned driving off) or `enabled:false` (kill switch, live: the planner drops its live entry on the next tick, `overloadMoves()` returns nothing, and unpinned driving stops). Enabling it later needs a restart (the planner is built only when the gate is on at boot). C3 follows admission: `monitoring.workAdmission.dryRun:true` stops new renices (already-lowered sessions keep nice 5 until they end). Code: revert the PR; the reconciler deps are optional and absent ⇒ today's behaviour; the state file is harmless when unread.

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action` — this change adds a self-triggered controller (`OverloadShedPlanner`: proposes ownership transfers on its own load evidence).
- **closure:** `guard`
- **guardEvidence.citation:** `tests/unit/self-action-convergence.test.ts` (controller `overload-shed` in `src/testing/selfActionRegistry.ts`, modelling `src/core/OverloadShedPlanner.ts`)
- **guardEvidence.enforcement:** `ratchet`
- **guardEvidence.howCaught:** under the pinned worst case (admission closed and enforced forever, a healthy peer with room, the peer NEVER claims and the transfer is never even started, so every proposal expires refundable) the REAL planner proposes at most 2 tries + 2 refunded tries per topic per overload episode; the episode never ends under pressure, so 5 topics settle at 20 proposals (`boundK` 20, `perTargetBoundK` 4) over 16 h of 15 s ticks and at 2× the horizon. The actuator is tighter still: the reconciler initiates at most one transfer per topic per episode (pinned by `tests/unit/overload-shed.test.ts`, "aborted once and never re-initiated"). The episode, attempt and refund counts are durable, so a restart under the same pressure continues the episode. Further pacing: one live move at a time, 2 moves/hour, 30-min topic cooldown.
- **component:** `OverloadShedPlanner`

---

## Second-pass review

**Round 1 — reviewer subagent (independent read of the artifact + diff): "Concern raised"**, 1 blocker, 3 should-fix, 6 notes. Resolutions (all in this change):

1. **Blocker — a target that never claims made the reconciler loop transfer → abort every deadline** (the planner entry outlived the 120 s abort, and nothing remembered the abort), so the real actuation count was ~5× the modelled bound → **fixed at the actuator**: the reconciler initiates at most one overload transfer per topic per episode; the planner also stops handing out an entry once its transfer started and records `aborted` when it comes back. Pinned by the "aborted once and never re-initiated" test (40 ticks: 1 transfer, 1 abort) and the planner abort test. The class-closure bound now models the planner honestly (incl. refunds) and names the actuator latch.
2. **Should-fix — unpinned driving was live while overload shed was in dry-run, and it covers every unpinned transfer** → **fixed**: gated on `enabled && dryRun:false`; §4 now states the authority honestly (drain, MeshRpc and suspended-pin transfers included; abort toward a live target).
3. **Should-fix — the one-live-move slot and its reservation were released at entry expiry while the transfer could still land** → **fixed**: both are held while the record is `transferring` toward the target.
4. **Should-fix — busy topics used up the hourly budget without moving** → **fixed**: busy topics are filtered in the planner; a proposal that expires without its transfer starting is refunded (capped at 2 per topic per episode so a reconciler that never acts cannot make it propose forever).
5. Timestamp fallback `?? now` → **fixed** to `?? 0`, the pinned path's fallback (a malformed record is driven, not stuck).
6. Target claims while overloaded itself → **fixed**: `acceptingMovedWork` refuses the claim while this machine's admission is enforced and closed; the source's deadline aborts it back.
7, 8, 10 → confirmed, no change. 9 (C3 limits: pre-existing separate process groups, no renice retry) → **documented** in §5.

**Round 2 — reviewer re-verification: "Concur"** (no blocker). Notes: (a) the actuator latch is in memory, so a restart in the window between a transfer landing and the planner's next tick can allow one extra transfer — bounded, documented in §5; (b) a transfer stuck in `transferring` forever (e.g. the reconciler switched off mid-move) holds the planner's one slot, so no further moves are proposed — fails safe, stated here; (c) the Summary paragraph is now aligned with §4 (the `dryRun:false` requirement and the refunds).
