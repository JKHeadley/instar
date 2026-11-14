# Side-Effects Review — Executor preparation epoch carry

**Version / slug:** executor-prepare-epoch-carry
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 1 runtime file plus harness and unit coverage, about 20 runtime lines. During `prepareAndSpawn`, an attempt on the canonical owner moves to a newer owner epoch through the existing `store.adopt` instead of failing its next fenced write. The last-tick record is written at the current epoch while canonical. Effort: no spec rounds.

## Decision-point inventory
- Preparation fenced writes — modify: a newer epoch on the canonical owner is adopted; otherwise unchanged and refused.
- `startNew` loop — modify: stops claiming more this tick once the epoch moved.
- `exec:last_tick` write — modify: written at the current epoch while canonical.
- Stop-path handling of claimed rows on a later tick — pass-through: a claimed row left by a dead process still stops as stale-epoch.

## 1. Over-block
Removes an over-block: a same-machine lease re-acquisition stopping valid work.

## 2. Under-block
Only the configured operated host can be canonical, so another machine cannot start a duplicate attempt in a lease gap. A check at the spawn step cannot see a lease lost during `spawnConfined` itself; such a session can exist on a non-owner until a later tick, and it can publish only after that machine regains the lease. Some writes after an await (`endAttempt` after `profileUnenforceable` or `depsUnavailable`, `setItemMeta` after `holdItem`) can still be refused; those fail safe and the next tick stops the row. The cause of the lease lapse is not fixed here.

## 3. Level-of-abstraction fit
Reuses `store.adopt`, the path used for running rows. Preventing the lapse belongs in the lease coordinator, is a wider multi-machine surface, and is filed separately. Fixing only this consumer leaves other epoch consumers exposed to the same lapse, which is why it is filed.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. The owner fence is an enumerable invariant and it stays. No new judgment; the decision uses the existing canonical-owner authority.

## 4b. Judgment-point check
No judgment point added.

## 5. Interactions
`this.running` stays true for the whole tick, so no second tick can stop the claimed row during preparation. The catch block carries the epoch first, so a capacity refund and a sandbox latch still land after a lease change. The owner fence only compares against the local store's recorded epoch, so the new direct canonical check is what stops a non-owner at the spawn step. The stale-epoch early return in the catch path is unchanged.

## 6. External surfaces
A new audit event, `execute:preparation-epoch-carried`. More attempts reach a session, so more model and CPU use, within the existing start and concurrency caps.

## 7. Multi-machine posture
Machine-local BY DESIGN: the carry applies only in the process that holds the attempt, and only while it is the canonical owner.

## 8. Rollback cost
Plain revert. Rows carry only a newer owner epoch, which the running code already accepts.

## Second-pass review
Concern raised, then addressed (independent subagent). It found no way for a non-owner to gain from the carry. Addressed: a false count and an overstated refusal claim in the notes, the catch block not carrying the epoch, a missing direct owner check before spawn (existing gap), and missing tests for the claim loop, for a capacity refusal after a lease change, and for a lease lost with no epoch change. Remaining writes it listed fail safe and are described in section 2.
