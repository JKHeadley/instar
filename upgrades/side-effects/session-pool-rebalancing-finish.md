# Side-Effects Review — finish session-pool rebalancing

**Version / slug:** `session-pool-rebalancing-finish`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** independent general-purpose subagent (Opus 5.5), concurred after fixes

## Summary of the change

Makes load-driven moves real. Peer session limits reach the capacity row; Overload shed picks only
conversations with a running session that has sat quiet; its moves go through the owner-side drain;
stage `rebalance` becomes the actual gate, backed by a proof store of its own; and a new proof route
moves a listed topic through the production path. Spec: docs/specs/session-pool-rebalancing-finish.md.

## Decision-point inventory

- `OverloadShedPlanner` source decision — modify — also needs session ratio at or above 0.85.
- `OverloadShedPlanner` live/held decision — modify — stage, fresh proof and dry-run; admission enforcement dropped.
- `OverloadShedPlanner` candidate filter — modify — quiet running session only; proof topics excluded.
- `OverloadShedPlanner` target filter — modify — requires known session numbers; closed admission excludes a peer whether or not it enforces.
- `StageAdvancer.advanceTo('rebalance')` and `reconcile()` at rebalance — modify — read the proof; CMT-1117 supersede does not apply.
- `SessionDrainRunner` `onNotQuiet: 'abort'` — add — an unrequested move aborts rather than wait or force.
- `OwnershipReconciler` overload loop — modify — drain, never a bare transfer; drain-flow records always driven.
- `RebalanceProofRunner` verdict — add.

## 1. Over-block

A machine short of CPU but not of slots no longer sheds. That is intended: idle moves cannot relieve CPU.
A topic busy at the moment of the drain stays; it is reconsidered after the scan. The 6-hour cooldown
uses the record timestamp, so a newly started conversation also waits 6 hours; those are the ones least
worth moving.

## 2. Under-block

While admission is unenforced, new work can land on a closed source, so shedding can keep up rather
than catch up. The breaker bounds it at 2 moves an hour and the ratio ends it when slots free. The
conformance gate flagged this; the practice rung measures it. A restart inside a drain can leave a
duplicate until `DuplicateSessionReconciler` clears it; it is counted as a duplicate.

## 3. Level-of-abstraction fit

The fill for peer capacity is in `assemble`, the one point every transport passes through. Moves reuse
the drain rather than a new close path. The stage gate stays in `StageAdvancer`, the sole stage writer.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. These are mechanical facts about capacity, ownership and signed
records, not judgments about meaning. Every read fails toward not moving, and authority stays with the
existing gates: the ownership CAS, the governor and the breaker.

## 4b. Judgment-point check

No static heuristic sits on a competing-signals decision. The source floor (admission closed, ratio at
0.85) and the quiet filter are structural bounds on an authority that is otherwise a mechanical capacity
fact, and each fails toward not moving. The maturation review, not these numbers, decides promotion.

## 5. Interactions

- Change 1 reaches below stage 3: `PlacementExecutor.score` now sees real peer ratios for new placements
  at every stage, and the dashboard glance shows peer counts. Both move toward the truth. Single-machine
  agents have no peers and are unaffected. This is the one part that changes behaviour on existing
  multi-machine agents.
- `ws13DryRun` holds shed drains. `driveUnpinnedTransfers` no longer gates drain-flow records.
- The failover runner now records stage 2 while at stage 3, and a current-build stage-2 red demotes
  rebalance, then the existing rule continues to shadow. Intended: broken failover is a reason to step
  further down.
- Shed drains journal as `reconcile`: a new placement reason would be rejected by peers on older builds
  and halt replication.

## 6. External surfaces

New routes `POST /session-pool/rebalance-proof` and `GET .../:runId`, Bearer-gated, refused unless a topic
is listed (default empty), 503 where shed is off. `/session-pool/e2e-results` stage 3 now reads the proof
store, so Echo's board stops showing the September red. New config `rebalanceProofTopics`. The proof
probe's text is fixed and labelled automated, so it is never read as the operator's words.

## 6b. Operator-surface quality

Not touched: no dashboard, approval or grant page changes. Routes and config only.

## 7. Multi-machine posture

Stage is coherence-checked. Proof rows and audit logs are machine-local by design: a machine sheds only
after it has itself proved it can. Ownership rides the journaled CAS, and the cooldown rides the
replicated record timestamp. Rollout runs the ring first, then raises the ceiling on all machines together.

## 8. Rollback cost

`monitoring.overloadShed.dryRun: true` stops new moves at once. Lowering the ceiling and stage uses the
guarded config path. No data migration. Change 1 can be reverted alone.

## Conclusion

Three spec rounds changed the design substantially: see docs/specs/reports/session-pool-rebalancing-finish-convergence.md.
Below stage `rebalance` nothing moves, so this ships with no live move on any agent except what change 1 does to placement
scoring. Clear to ship once tests and the second pass agree. Done still needs the real Telegram check after a real move.

## Second-pass review

**Reviewer:** independent general-purpose subagent (Opus 5.5), read the diff and this artifact cold
**Independent read of the artifact:** concur (after two rounds of fixes, see below)

First read raised nine code bugs, all fixed with tests: a spawned proof session was not linked to its
topic; the quiet scan's cap ran before the movable filter; a proof entry survived restart with no waiter
and a run cut off by a restart left no row (now a durable marker records it red at boot);
`overloadMoves()` did not recheck the switches, so dry-run did not stop a pending proposal at once;
disabling the shed left a proof hanging; the late-runner fence kept the local session when the target had
already claimed; the pre-drain re-read skipped `loadVerdict`; a failed read could erase a reply already
seen; and a reconciler dry-run was silent and let a proof expire as red.

Re-read raised four more, all fixed: a settle window could end green while the target history was
unreadable; a bad in-flight marker could break boot; the live-move switch ignored the reconcile gate; and a
refused close went unaudited. A last read found the same unreadable-target gap through a read that throws;
fixed with tests. Final word: concur.

After review, running the tests with their own exit codes found two stale rigs: the route integration test
and the self-action worst-case model both built the planner without the new gates, so the planner held and
the model's bound checked nothing. Both now open every gate; the route test also asserts a source below
stage `rebalance` stays held.

## Found by the full unit lane

The first merge verify failed 4 of about 57,000 unit tests, all from this change: a hand-kept line map in the
dark-gate lint test, a source-text assertion on the drain's journal reason, a capability prefix the lint cannot
see, and no write-domain entry for the proof route. `POST /session-pool/rebalance-proof` is `machine-local`,
because each machine, standbys included, earns its own proof.

## Merged with the recording work

After #2704 landed, the planner keeps both: main's `featureEvidence` records and this change's audit rows and
proof settling. The evidence record for a held move carries the hold reason.

The second verify then tripped the silent-fallback ratchet (495 over 494) on the proof runner's catch. It is not
silent, since the error becomes the run's recorded reason, so it carries the marker and the baseline stays.

## Ladder

The spec's ladder line names the existing `monitoring.overloadShed` entry, which gains the alias
`session-pool-rebalancing` and this spec's bars read from `logs/overload-shed.jsonl`. `multiMachine.sessionPool.stage`
gains the alias `session-pool-default-on`.

## Class-Closure Declaration

Defect class `unbounded-self-action`, closure `guard`, enforcement `ratchet`, citing
`tests/unit/self-action-convergence.test.ts`. Overload shed is a registered controller. Its steady-state
bound is at most 4 moves per topic per episode, 2 moves an hour, one live move at a time, and a 6-hour
per-topic cooldown. The ratchet runs the real planner with every live-move gate open.

## Evidence pointers

Live readings: `GET /overload-shed`, `GET /pool`, `.instar/session-pool-e2e-results.json` on Echo, 2026-11-03.
