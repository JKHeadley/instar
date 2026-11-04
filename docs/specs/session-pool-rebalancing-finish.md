---
title: "Finish session-pool rebalancing: a stage that means something, moves that work, and a real proof"
slug: "session-pool-rebalancing-finish"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "docs/specs/session-pool-rebalancing-finish.eli16.md"
review-convergence: "2026-11-04T02:54:29.000Z"
review-iterations: 3
review-completed-at: "2026-11-04T02:54:29.000Z"
review-report: "docs/specs/reports/session-pool-rebalancing-finish-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: "echo (autonomous run; Justin 2026-11-03 17:11 PST, topic 136110, 'yes, agreed' to finish rebalancing)"
---

# Finish session-pool rebalancing

## Problem statement

The maturation board shows `multiMachine.sessionPool` stage 3 (rebalancing) as red. Read against the
live system on 2026-11-03, that label hides a different situation. Rebalancing has never run.

Measured on Echo (5 machines, version 1.3.1641):

1. **The red is not about rebalancing.** `.instar/session-pool-e2e-results.json` holds 771 stage-3
   rows: 770 green, 1 red (2026-09-24T01:44Z, version 1.3.1270). Every one came from
   `SessionPoolFailoverRunner`, which runs `tests/e2e/sessionpool-failover-two-node.test.ts` and
   credits whatever stage is configured. The red was that test's own "A is unreachable" probe
   (`expect(aReachable).toBe(false)`, line 98, 64 ms in). So the 770 greens prove nothing about
   rebalancing either.
2. **Stage `rebalance` switches nothing on.** No code branches on it except two places that treat it
   the same as `live-transfer` (`machineCoherenceManifest.ts:455`, `seamlessnessConfig.ts:128`). The
   spec's "Stage 3: load-driven proactive transfers enabled" was never wired.
3. **Load-driven moves live elsewhere.** `OverloadShedPlanner` (trustworthy-machine-load Part D) is the
   only caller of `planRebalance`. It has its own gate and is dry-run on Echo.
4. **The shed can never find a target.** `targetEligible` requires `typeof m.maxSessions === 'number'`.
   `PeerPresencePuller` forwards `loadReport` but not `activeSessionCount`/`maxSessions`, so every peer
   row has them undefined while `loadReport.sessionsMax` is 10. Live counters: 52 ticks, 0 would-move,
   9 noTarget, no `logs/overload-shed.jsonl` at all. The board's "0 moves needed" means 0 moves
   possible. `tests/e2e/overload-shed-lifecycle.test.ts` hand-feeds both fields, which hid this.
5. **It would pick conversations that free nothing.** `ownedTopics` is every `active` ownership record
   owned here: 163 on Studio, 143 of them over a week old, against 18 running sessions. Moving a topic
   with no running session relieves no load.
6. **A shed move would not stop the session.** The reconciler's overload path does a bare
   `{type:'transfer'}` CAS. Only `SessionDrainRunner` closes the source session and lands the claim,
   and only the `/pool/transfer` and mesh `drain` paths call it. A shed move would leave the session
   running on the overloaded machine with ownership pointing elsewhere.
7. **Live moves also wait on a second feature.** `live = !cfg.dryRun && adv?.enforced === true`, and
   `monitoring.workAdmission` is in dry-run with a board reading of about 55 would-pause events a day.
8. **Why the red still shows.** The store's newest stage-3 row is that September red: no stage-3 row has
   been written since.

## Proposed design

Seven changes, all in existing modules except one small route.

### 1. Peer capacity reaches the capacity row

`MachinePoolRegistry.assemble`: when `activeSessionCount` / `maxSessions` are absent, a FRESH load
report fills them. A stale report fills nothing. Shed's `targetEligible` additionally requires both
numbers, so a null `sessionsActive` can never read as free.

This is a change at every stage, not only stage 3: `PlacementExecutor.score` now sees real peer session
ratios for new placements, and the dashboard glance shows peer counts. Both move toward the truth, and
the self row was already filled the same way, so scoring becomes symmetric. It is the one part of this
spec that reaches agents below stage 3; a single-machine agent has no peers, so it is unaffected.

### 2. Only quiet conversations with a running session are candidates

`tick()` stays synchronous. A separate async pre-pass, run only while this machine is a source, fills a
set of idle topics: it intersects owned topics with one cached listing of running sessions, keeps those
with no activity for at least 10 minutes, orders them oldest activity first, takes at most 5, and calls
`checkSessionWorkState` on each. `working` and `indeterminate` stay out, and absent sessions were already
removed by the intersection, because that call reports `idle` for an absent session. The 10 minutes
means a conversation between turns is not treated as finished. A topic outside the set is not a
candidate, so a failed probe never moves anything.

The honest limit: an idle session frees a session slot and its memory, not CPU. That is what this
feature promises. It does not claim to relieve CPU.

### 3. A shed move goes through the drain, with no waiting

Because only idle sessions move, a shed move never waits for a turn to end. The reconciler's overload
loop calls a new `drainMove(mv, epoch)` instead of the bare transfer CAS. A missing drain runner means
no move. `drainMove` runs from the synchronous tick as a caught, single-flight promise that holds its
slot until the runner settles, respects `ws13DryRun`, counts in pacing, and re-reads the target
(`acceptingWork`, verdict, liveness) just before starting.

`SessionDrainRunner.run` gains `onNotQuiet: 'wait' | 'abort'` (default `wait`, today's behaviour).
With `abort` it awaits one work-state read (a new async dep) after the ledger leg and before the
autonomous-suspend step, and anything but `idle` aborts with new status `aborted-not-quiet`, leaving the
session running. There is no wait loop, so no bound to tune; the ledger leg's own 15 s cap is the long
pole, inside the 45 s claim grace. Before closing the session, the runner re-reads the record and goes
on only if it is still this transfer at this epoch, so a late runner cannot act on a topic the target
already claimed. If the abort CAS fails, it re-reads too: it closes the local session only when the
record shows the target as active owner, and otherwise leaves it and audits. Shed drains journal as the
existing `reconcile` reason, not a new one: peers reject an unknown placement reason and halt replication,
so a new value would break any machine on an older build.

Why a drain and not simply closing the idle session and letting the next message re-place it: the
drain already gives the durable ledger handoff, the refused-close protection from 2026-10-23, and the
target's reservation and working-set prefetch. Reusing it is one call; dropping it would rebuild those.

After a landed move the same working-set kick `/pool/transfer` uses carries the conversation's context
to the target. The escalation hint that route files is not repeated: it is best-effort enrichment for
sessions on an escalated model, and the destination re-decides from real state anyway.

The outcome returns through `noteMoveOutcome`, which replaces the inferred path:

| `DrainStatus` | Planner result | Counts on breaker | Attempt spent |
|---|---|---|---|
| `drained`, claim landed | moved | yes | no |
| `drained`, claim lost | moved, reconciler backstop claims | yes | no |
| `refused-*`, `aborted-*` | not moved, reservation released at once | no | yes |
| held by `ws13DryRun` | would-move audit only | no | no |

A runner that never settles keeps the single-flight slot and blocks further moves, audited after 2
minutes. That is the safe direction.

Restart: the reconciler's unpinned drive always handles a record with `drainInFlight`, whatever `dryRun`
says, so a topic is never stranded: the target claims after grace, or the transfer aborts past the
deadline. A restart inside the seconds-long drain can leave the source session running after that
claim. `DuplicateSessionReconciler` is the existing cover for that case, and such a row counts as a
duplicate in the measures, because it is one.

### 4. The stage is the gate

`live = stage === 'rebalance' && proofFresh() && !cfg.dryRun`, read live each tick. The
SelfActionGovernor admission and the breaker that follow it stay exactly as they are. Held moves audit
`stage-not-rebalance`, `proof-not-fresh` or `dry-run`.

**The source decision changes in one way.** A machine is a source when admission has been closed for
`sourceAfterMs` AND its session ratio is at least 0.85, the threshold the pool spec named for stage 3.
This replaces the enforcement requirement. The admission signal flaps on CPU spikes (about 55
would-pause events a day), so alone it should not carry move authority; a machine that really is short
of session slots is exactly the case this feature relieves. When the ratio falls, shedding stops, so
it cannot run away. This departs from the trustworthy-load plan's order, where enforcement came first.
That is a deliberate decision recorded here: requiring enforcement would hold rebalancing behind a
feature with its own unresolved flapping, and the ratio is a stronger reason to move than enforcement was.

The honest limit: while admission is unenforced, new work can still land on a closed source. The
machine-wide breaker (2 moves an hour) caps total moves regardless.

### 5. A separate proof record, and a gate that reads it

The proof has its own signed store, `session-pool-rebalance-proof.json`, a second
`SessionPoolE2EResultStore`. No schema change, and the 771 legacy rows cannot qualify because they are
in a different file. The legacy rows stay as history.

- `provenStage` caps at 2: the failover check proves failover, so at stage 3 it records as stage 2.
- A proof is **fresh** when the LATEST row in the proof store is green, verified, and at most 30 days
  old. A later red supersedes any earlier green, and a failover green supersedes nothing here: proof
  and failover are independent checks, so the CMT-1117 supersede rule does not apply at stage 3.
- `advanceTo('rebalance')` needs the existing stage-2 green AND a fresh proof.
- `reconcile()` at `rebalance` reverts to `live-transfer` when the proof is not fresh, and on a
  current-commit stage-2 red. A stage-2 red then keeps reconciling as it does today at
  `live-transfer`: failover being broken is a reason to step down further, so 3→2→1 is intended.
- Re-promotion cap: `MAX_TARGET_REDS_PER_COMMIT` for target stage 3 also counts stage-2 reds for that
  build, so a flapping failover check cannot flap stage 3.

### 6. Ping-pong

New `topicCooldownMs` (6 hours) is the planner's `placementCooldownMs`, and `ownedTopics` supplies each
record's replicated `timestamp` as `lastTransferredAt`, so the cooldown follows the topic across
machines. `recentShedMs` stays 30 minutes, because it also sets episode continuity and the refusal ban.
`targetEligible` treats `loadReport.acceptingWork === false` as ineligible whether or not the peer
enforces, so a closed source is never a target.

### 7. The proof: `POST /session-pool/rebalance-proof`

Body `{ topic, to }`, Bearer, 202 with a run id, `GET` reads it. It needs no sender account. Telegram
ingress is not what this feature changes, and bots cannot see other bots' messages, so the probe enters
at the router's forward, the same point a real inbound reaches.

`planner.proofMove(topic, to)` runs the production path, planner proposal → `overloadMoves()` →
reconciler → `drainMove` → drain → outcome, with five named exemptions and nothing else: the source
trigger, the stage gate, `dryRun`, the topic cooldown (listed proof topics only), and the target
(restricted to `to`, which must still pass `targetEligible`). It uses a per-run episode id and stamps
no shed state: no breaker, cooldown or refusal entry. **What the proof therefore does not exercise:**
the overload source decision and the stage gate. Those have unit and e2e coverage, and the practice rung
measures the source decision live. Proof moves carry `proof: true` and are left out of rung measures.
Listed topics are never shed by the normal path.

Preconditions, else 409 with nothing recorded: topic listed in
`multiMachine.sessionPool.rebalanceProofTopics` (default empty), this machine owns it, stage at least
`live-transfer`, no live move or proof running. If the owner has no session for the topic (idle sessions
die after 240 minutes), the proof spawns one with `spawnSessionForTopic` and waits for it to go idle.

Green needs all of these, observed outside the drain:
1. The record polls to `status: active`, target as owner, higher epoch (`ownerOf` alone reports
   `transferTo` mid-transfer).
2. No session for the topic is left on the source (a fresh read of the session list).
3. A probe goes in through in-process `_sessionRouter.route()` with no sender envelope, which reaches
   the new owner and spawns there. Its text is fixed and server-authored: labelled as an automated check,
   nonce only, no caller text, so a session never reads it as the operator's words. Then
   `GET /telegram/topics/:id/messages?scope=pool` shows exactly one agent row containing the nonce, tagged
   with the target machine, within 180 s. If the target is listed in `pool.failed`, that read does not
   count as no reply, and it polls on.

| Outcome | Record |
|---|---|
| Refused before any move started | nothing |
| Started, and all three hold | green |
| Started, and anything else, including a timed-out read | red |

A started run always leaves a row, so old authorization cannot outlive a run that could not establish
what happened. A red is cheap: that machine steps down to `live-transfer` until a rerun passes, and the
weekly job reruns once on red. Stage is checked again after the run; if it changed, the run is red. The evidence file is
`logs/rebalance-proof/<iso>.json`, from an allowlist: machine ids, session counts, verdicts, statuses,
timings. A failure on the target records red against the source: the pair failed, and the evidence names
both.

**How all five machines are proven.** Rows are machine-local by design: a machine may shed only after
it has itself proved it can. The topic travels: each machine, as owner, runs one proof naming the next
machine, and an unavailable machine is skipped and retried later. Order: ship; run the ring with the
ceiling at `live-transfer`, so no stage changes; raise `promotionCeiling` on all machines, and each
climbs within a minute, with `dryRun` still true; soak at `rebalance` in dry-run through the practice
rung; only then set `dryRun:false`. `sessionPool.stage` is a coherence key, so a machine that could not
prove itself stays lower and raises a coherence episode, which is the correct signal.

**The real channel.** This route is the repeatable gate, not the user-channel proof, because the probe
skips Telegram's own ingress. Under Live-User-Channel Proof Before Done, the feature is not done until,
after a real move, a labelled message from Echo sent through real Telegram in the proof topic (the
`justin-telegram` browser profile the operator set up for this) is answered by the target machine, with
the screen captured as evidence. Slack does not apply: the shed moves Telegram topics only, and Slack
conversations stay where they are.

**The probe enters at the lease holder.** Only the holder receives real inbound, and a peer's forward is refused
as `not-router`. So a proof on any other machine hands its nonce to the holder through
`POST /session-pool/rebalance-proof/probe`, which builds the same fixed text and routes it. If the move's target
is the holder, it handles the probe rather than forwarding it, and that counts. Found live on 2026-11-04: the Mini
moved a conversation correctly and its proof went red with `probe-queued`.

**A Linux session is not busy forever.** On Linux, `npm exec` starts the Playwright server through `sh -c playwright-mcp`.
That reads as a tool shell, and a tool shell outranked the baseline list, so every such session looked busy for good: a
proof could not start, and a drain aborted. Found live on 2026-11-04 on Mama PC, which went red with `aborted-not-quiet`
and then `no-idle-session` on a session plainly sitting at its prompt. macOS has no such shell, which is why the Macs
passed. `computeHasActiveProcesses` and `drainProcessShape` now recognise exactly that launcher: a plain one-command `sh -c`
naming an mcp binary, whose direct parent is `npm exec` or `npx` of an MCP package. Any other shell stays work.

**Idle has to hold.** A session still starting reads as idle, so the proof waits for six idle reads in a row of the same
session, five seconds apart, before asking for the move; any other read starts the count again. A brief delivered later
than that can still abort a move, which is a named red and never a false green. The evidence's `sourceSessionGone` is a
real session read on every path, so a failed move that leaves the session running says so.

**What "exactly one reply" covers.** It is read across the machines that can be read, and the target must be one of
them. A machine that is off cannot make the proof red: only the source and the target can receive the probe, and
requiring every machine would fail a whole ring because one laptop is shut. Any step that could hang has its own
deadline, and a started run that ends in an error still records red.

Echo's proof topic is a labelled topic created by Echo. A weekly Echo job reruns the ring. Proofs last
30 days and are not tied to a build, because each one moves a real conversation; the live measures
cover the gap between them.

## Maturation plan

- **ladder:** monitoring.overloadShed

The audit gains two row types, each carrying a capacity snapshot (source and target active/max, target
verdict) and `workState`: `would-move` (now one row per episode per topic) and `move-outcome` (status,
claim landed, duration, reason).

| Measure | Symbol | How it proves the real state |
|---|---|---|
| Decisions | distinct episodes with a `would-move` row | episode ids, not rows |
| Good decision | `workState: idle`, source ratio 0.85+, target had 2+ free slots | the snapshot's fresh load reports and the work-state read, neither produced by the filter's own result |
| Move landed | `move-outcome` with `drained` and claim landed | ownership record read back as active on the target; a topic that stays quiet has nothing further to show |
| Duplicate | `logs/duplicate-reconciler.jsonl` row for the topic within 1 h of a move | written by a separate detector |
| Lost message | inbound queue terminal failure for the topic within 1 h of a move | queue's own ledger |
| Bounce | same topic in two `move-outcome` rows within 24 h | merged across machines |

Logs stay per machine. `GET /overload-shed?scope=pool` merges peers' `move-outcome` rows read-only,
following `/judgment-provenance?scope=pool`.

| Rung | Who | Threshold to climb |
|---|---|---|
| practice | Echo at `rebalance`, dry-run | every online machine holds a fresh proof; 20+ episodes over 7 days; 90%+ good decisions |
| development | Echo at `rebalance`, live | real-channel check passed; 10+ landed moves; 90%+ landed; 0 duplicates; 0 lost messages; under 10% bounces |
| fleet | new multi-machine agents | development held 14 days; same rates; a proof any agent can run |

Numbers never move the feature on their own: the server measures and raises, the review job decides.

## Decision points touched

- **Source decision** (admission closed 3 min and session ratio 0.85+): invariant with floors. Its
  bounds are structural: idle only, 2 moves an hour, one at a time, a 6 h cooldown that follows the
  topic, and it stops when the ratio falls.
- **Live/dry decision:** invariant, config facts.
- **Candidate filter:** invariant, fails toward not moving.
- **Stage gate and proof verdict:** invariant, signed records plus a real reply from the target.
  The proof store's rows also appear on `GET /session-pool/e2e-results`, which is where the board's
  stage-3 reading must come from once this ships.
- **Target choice:** unchanged, `PlacementExecutor.decide`.

## Multi-machine posture

Stage is coherence-checked across machines. Proof rows and audit logs are machine-local by design,
with the merged read above. Ownership moves through the journaled CAS, and the cooldown rides the
replicated record.

## Migration

`rebalanceProofTopics: []` goes in `ConfigDefaults`, which existing agents receive through `migrateConfig`; `topicCooldownMs` has a code default and needs no config entry. The template text in
`src/scaffold/templates.ts` and both `PostUpdateMigrator` copies that say "ordinary cooperative
transfer" and "moves nothing while admission is in dry-run" change, with a content-sniffed
`migrateClaudeMd` step. An agent already at `rebalance` is handled by change 5, with no migration.

## Rollback

`monitoring.overloadShed.dryRun: true` stops new moves at once; a drain already running finishes or
aborts, because stopping it midway is the unsafe state. To step down, set `promotionCeiling` and edit
`stage` through the existing guarded config path. No data migration. Change 1 reverts alone.

## Open questions

None needing the operator. The one change of plan, moving ahead of enforcement, is recorded in change 4.
