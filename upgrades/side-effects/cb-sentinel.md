# Side-effects review — ContextBudgetSentinel, Phase 0 core

**Version / slug:** `cb-sentinel`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §7.8 (the session and the sentinel), §9.3 "Quarantine" ("Reconciliation has a numbered bound (default 15 minutes) … the sentinel **force-ends** the candidate and **verifies termination** (tmux absent, no live child process, no transcript growth for one tick); only then does it take the `rollback-degraded` path, release the holds and raise one notice … If termination cannot be verified, containment **stays** … and the sentinel escalates to the operator through the Attention queue with the topic named; nothing is released on an unknown"), §9.4 (ladders as `SelfHealGate` declarations), §16 Phase 0 ("the sentinel skeleton (canary …, boot sweep, quarantine reconciliation)"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 10, part b (the canary is part c).
**Tier:** 2 (a sentinel with authority to end a session and release a conversation's holds; new fold precondition source). Size: ~6 source files, ~330 LOC + ~400 test LOC.

## Summary of the change

1. **`src/monitoring/ContextBudgetSentinel.ts`** (new). Each tick (5 min), in order:
   - **Quarantine reconciliation** — every `quarantined` record runs through a pool-shared, async `SelfHealGate` ladder (`context-budget-quarantine-reconcile`, one episode per fold, ≤ 12 attempts, 45-min wall clock, own SQLite store `state/context-budget/self-heal-episodes.db` with a ring of four per topic+cause). Within the 15-min bound it calls the rollback runner (Phase 2; absent ⇒ waits). Past it: force-end every candidate (the topic's live sessions; a refused kill — e.g. a protected session — is audited and the others still end), record a DURABLE termination snapshot (topic, tmux names, transcript sizes), and on a later tick verify: every one of those tmux sessions DEFINITELY gone (a three-state probe; a probe error or timeout is `unknown`, never "gone"), no live session on the topic, every recorded transcript readable and the same size. The snapshot only GROWS across attempts and restarts and is dropped only when the record is known absent or no longer quarantined (never on a torn read or a failed listing), so evidence is never forgotten. An EMPTY snapshot (the candidate died with a crash and left no session) is no evidence of termination: containment stays and the ladder escalates. A missing or bad `updatedAt` waits rather than ending a session early. Verified ⇒ the notice is written to a DURABLE outbox, then `transition(…, 'rolled-back', reason 'rollback-degraded: …')` (fenced by the record's CAS and the sentinel's lease generation; releases every carrier), and the outbox sends ONE Attention item (HIGH) once the record reads rolled-back — retried every tick across a down channel or a restart. Not verified ⇒ end again and re-measure; containment stays; ladder exhaustion ⇒ one URGENT Attention item naming the topic, record stays `quarantined`.
   - **Torn records** — a fold record file that exists but cannot be read: one URGENT Attention item per record on topics this machine owns, raised once durably (`torn-raised.json`) through the durable outbox, and again if it recurs.
   - **Outbox** — pending notices are sent each tick until delivered.
   - **Checkpoint grace pass** — `pruneSettledCheckpoints` (the 9a reviewer's prerequisite for any checkpoint taker).
   - **Gate prune** — after the attempts (10a's idle rule assumes attempt-before-prune and a tick well inside the wall clock; the constructor refuses a tick over half the wall clock).
   - **Heartbeat** — `heartbeatFresh()`: refreshed only by a CLEAN tick (every step succeeded, none timed out, the ladder's episode store usable); each step is bounded at 2 minutes so a hung dependency cannot wedge the sentinel.
   - The gate's latency notice ceiling is the bound plus two ticks, so a quarantine waiting out its bound sends no "slow" notice.
2. **Torn-record guard** (`FoldCoordinator.ts`, `engineCheckpoint.ts`, `foldCarriers.ts`): `FoldRecordStore.inspect()` tells absent from torn and `tornRecords()` lists them; the boot sweep KEEPS every carrier of a torn record (holds, markers, injects, checkpoint) and reports it in `torn`; the checkpoint carrier never deletes on `'unreadable'`; `begin` refuses a new fold on a topic with a torn record (`torn-record`). Closes the 9a review's hard gate ("a torn record deletes the only restore target").
3. **Server wiring** (`server.ts`, `contextBudgetSentinelBoot.ts`): ships DARK — `contextBudget.sentinel.enabled` defaults false everywhere (it can end a session, so it is not a dev-agent default per the dev-gated registry's rule; it is turned on deliberately for the Phase 0 verification on the test agent); the session closures (candidates, transcripts, the three-state `tmuxHasSession` probe, the kill) live in `productionSentinelSessionDeps`, which the e2e uses too; built after the boot sweep; the coordinator's `sentinelHeartbeatFresh` reads it lazily; first tick 30 s after boot, then every 5 min (timers unref'd); torn records from the sweep reported through DegradationReporter. Ownership mirrors the coordinator's own rule (pool placement live ⇒ unknown ⇒ observe only).
4. **Guard inventory**: declared in `GUARD_MANIFEST` (`contextBudget.sentinel`, config, default off, 5-min tick).
5. **Governor policy + self-action registry**: `context-budget-quarantine-reconcile` (relief, pool-shared, open-audited, 12 per fold / 48 per day) and its convergence model.

**Phase 0 posture:** dark by default; no fold can begin (`topicRowsPresent` is false until Phase 1, and with the sentinel dark there is no heartbeat), so no record reaches `quarantined`. Owner: Echo; review date: the Phase 0 verification run (task 11) turns it on for the test agent. <!-- tracked: CMT-1536 (Phase 0 task 11: enable the sentinel on the test agent; Phase 1: decide the dev-agent default) -->

## Decision-point inventory

- **Added:** release of a quarantined fold's containment (rollback-degraded) — only after force-end AND verified termination, through the coordinator's fenced transition.
- **Added:** the heartbeat precondition reads the sentinel (dark ⇒ false ⇒ no fold).

## 1. Over-block

- An unresolvable transcript path keeps containment and escalates (by design: no evidence of quiet is not quiet). A topic whose candidate runs under a framework without a resolvable transcript would always escalate rather than self-release.

## 2. Under-block

- **Candidate identity:** candidates are the topic's live sessions at each attempt. A candidate that died with a crash and left no session gives an empty snapshot, which is NOT accepted as termination: such a fold escalates to the operator instead of self-releasing. Phase 2's runner records the candidate's tmux name and transcript in the fold sidecar at the replacing step so the check can verify it directly, and Phase 1 must not turn `topicRowsPresent` on before that exists. <!-- tracked: CMT-1536 (Phase 2 runner: record the candidate session and transcript in the fold sidecar; the sentinel's termination check reads them) -->
- "No live child process" is approximated by tmux absence plus transcript quiet (a surviving child writing the transcript shows as growth).
- Rollback runner (step 8 proper: restore the engine checkpoint, discard staged writes) is Phase 2; until then every quarantine waits the full bound and ends `rollback-degraded`. <!-- tracked: CMT-1536 (Phase 2: the step 8 rollback runner the sentinel calls within the bound) -->
- The canary, the 9.1 heal ladder and the status route are task 10c; the remaining §7.8 watch rows (freshness, hold health, eligible topic without a fold) are Phase 1. <!-- tracked: CMT-1536 (Phase 0 task 10c canary + status route; Phase 1 remaining sentinel rows) -->

## 3. Level-of-abstraction fit

The sentinel acts only through the coordinator's fenced transition and the gate; it holds no parallel state machine. The torn guard lives in the store and the sweep, where release happens.

## 4. Signal vs authority compliance

It holds authority (end a session, release holds), gated by deterministic, multi-signal verification (record CAS + lease generation + tmux + transcript), never a single brittle check, and it fails toward containment.

## 5. Interactions

- **Fold hold / inbound hold / markers / injects / checkpoint:** released only by the terminal record (rolled-back), as for any rollback; the checkpoint is kept 24 h (rolled-back rule) and later pruned by this sentinel.
- **SessionManager:** `killSessionByTmuxName` honours protected sessions; a protected candidate stays alive ⇒ not verified ⇒ escalation.
- **Self-action governor:** relief controller, fail-open-audited, so a governor fault never pins a conversation paused.

## 6. External surfaces

Attention items (rollback-degraded HIGH; containment-stays URGENT; torn record URGENT). Nothing to the user's topic.

## 7. Multi-machine posture

Per-machine instance; acts only on folds this machine owns (pool placement live ⇒ `unknown` ⇒ observe only); its episode store, snapshots and torn-raised set are machine-local by design (they describe this machine's processes).

## 8. Rollback cost

Revert, or leave `contextBudget.sentinel.enabled` off (the default). With it off, no heartbeat ⇒ no fold begins. The torn guard only keeps more (never releases more).

## Class-Closure Declaration

- `unbounded-self-action` — closure `bounded`: registered controller `context-budget-quarantine-reconcile` with governor policy; per-fold ladder ≤ 12 attempts / 45 min; exhausted folds retained 24 h; ring of four per topic+cause; convergence model in `selfActionRegistry`.

## Evidence

- `tests/unit/ContextBudgetSentinel.test.ts` (26): heartbeat absent/fresh/stale; within the bound the runner rolls back (healed) or the fold waits with containment intact; past the bound force-end then a later verified termination ⇒ rollback-degraded, carriers released, the FULL notice list is exactly one notice; containment stays when the transcript grew, is unreadable, or the session is alive; an unresolvable transcript escalates exactly once URGENT naming the topic; the snapshot survives three restarts and never verifies vacuously; a session seen later joins the snapshot and is ended; a non-owner observes only; torn: store tells absent from torn, boot sweep keeps every carrier and reports it, absent records are still orphans, the checkpoint carrier keeps on `unreadable`, the owner raises one durable Attention item and again on recurrence, a non-owner does not; checkpoint grace pass; tick-interval contract. Review round 1: a record torn for one tick keeps the snapshot; an unknown tmux probe never verifies; a crash with no session escalates instead of releasing; the notice survives a down channel and a restart (new instance) and is sent once; a missing timestamp waits; a refused kill does not stop the others; a failed step does not refresh the heartbeat; a torn record refuses `begin`; `tmuxHasSession` is three-state.
- `tests/integration/context-budget-sentinel-quarantine.test.ts` (1): `buildFoldCoordinator` + default carriers + real checkpoint, clear-seed pointer and fold-tagged inject + the real governor under the registered policy + the real SQLite episode store: rollback-degraded releases the pointer and inject, keeps the checkpoint settled, one notice, own store file.
- `tests/e2e/context-budget-sentinel-lifecycle.test.ts` (3): a REAL child crashes past the point of no return; a server-style boot quarantines it with containment kept; the sentinel (built with the production session closures) heartbeats and, with no evidence the candidate ended, keeps containment and tells the operator once; a REAL tmux session as the candidate is ended through the production closures, confirmed gone by the real three-state probe, and the fold rolls back; WIRED source check (dark default, after the sweep, the production closures, lazy heartbeat, 5-min interval, governor handle).
- Self-action suite (811 tests incl. convergence and verb-token coherence), fold/checkpoint/layer-kind tests, `tsc --noEmit` green.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10 04:00 PST): "Concern raised."** BLOCKING: (1) a record unreadable for one tick erased the termination snapshot (probe: an unresolvable transcript then a one-tick tear ⇒ rolled back, hold released); (2) the wired tmux probe returned false on any error or its 5-s timeout, and a failed kill still removed the row, so a slow tmux plus a quiet transcript verified a live session as gone; (3) the single rollback-degraded notice was lost when the Attention channel was down (transition first, then a throwing send; nothing retried). MINOR: a "slow to recover" notice on every quarantine (ceiling below the bound); a missing `updatedAt` ended a session 30 s in; a torn record did not block `begin`; the zero-candidate case released on absence of evidence and the e2e locked it in; a hung step wedged the sentinel; the heartbeat stayed fresh when steps failed; a protected session aborted the kill loop; the gate was not in the dev-gated registry; smaller items (torn raised-set on a throw, state-failure wording, `noticeTopics` growth); test quality (instant stubs, id-filtered notice assertions, the e2e hand-wrote its deps).

**Resolution:** all three BLOCKING fixed — snapshots dropped only on a known end (absent, or readable and no longer quarantined); a three-state probe (`tmuxHasSession`, unknown never verifies) and kills judged by the probe, not the row; a durable outbox written before the transition and sent once the record reads rolled-back, retried every tick. Minors: latency ceiling = bound + two ticks; NaN age waits; `begin` refuses `torn-record`; an empty snapshot is not termination (escalates); each step bounded at 2 min; heartbeat only on a clean tick (a `state-failure` from the ladder fails the step); refused kills are audited and the loop continues; the sentinel now ships DARK by default (it can end sessions, so it does not belong in the dev-gated registry), turned on deliberately for the verification run; torn notices go through the outbox; state-failure has its own wording; `noticeTopics` is rebuilt each tick. Tests: every case above, the full notice list asserted, and the e2e now builds the sentinel with the production session closures and runs one scenario against a REAL tmux session. Not changed: the interval is not cleared on a second in-process `startServer` (the server is one process per agent); a restart more than 15 min after quarantine skips the runner (Phase 2 runner concern, recorded above).

**Re-check (same reviewer, 2026-11-10 04:09 PST): "Concur with the review."** Every probe now passes: one-tick tear keeps the snapshot; an unknown tmux probe never verifies (and a definite answer then rolls back); the degraded notice is delivered once after the channel recovers; a missing `updatedAt` ends nothing early; a refused kill is audited, the other candidate ends, containment stays and the ladder escalates URGENT; a failed step leaves the heartbeat stale; one notice per clean rollback-degraded; `begin` refuses a torn record; an empty snapshot escalates instead of releasing; the real probe reads a missing session as `false`. New minors and their resolution:
1. A queued degraded notice could be sent after the fold ended another way — fixed: sent only when the record reads `rolled-back` with a `rollback-degraded` reason; any other end drops it (test).
2. A permission error on the tmux socket read as "gone" — fixed: only "No such file or directory" / "Connection refused" mean no server; permission denied is `unknown` (test).
3. The probe hard-coded `tmux` — fixed: it uses the configured `sessions.tmuxPath`.
4. Outbox read-modify-write could drop an entry queued meanwhile — fixed: re-read before the write, deleting only the entries this flush finished.
5. Empty-snapshot and protected-session folds have no release path except the operator — accepted for Phase 0 (they escalate, never release); an operator "I confirm it is gone" action belongs with the Phase 2 runner. <!-- tracked: CMT-1536 (Phase 2: operator confirm-terminated action for an escalated quarantine) -->
6. The dark flag's owner and review date — stated in "Phase 0 posture" (owner Echo; turned on for the test agent in the task 11 verification run; dev-agent default decided in Phase 1).

**Post-commit fix (2026-11-10, found by a whole-stack run of every changed test file):** (1) `tests/integration/fold-coordinator-boot-wiring.test.ts` (task 7) still asserted the OLD torn-record behaviour (carriers released as orphans); this slice deliberately changed it, so the test now asserts the new rule — nothing released, the record reported in `torn`, every carrier still present. My per-slice test selection only ran files the slice touched, so it missed this one. (2) The tick step wrapper's catch now carries its `@silent-fallback-ok` reason (it is not silent: `lastError`, an audit row, and a stale heartbeat), bringing the no-silent-fallbacks count back to its baseline.
