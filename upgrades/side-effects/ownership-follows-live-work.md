# Side-Effects Review — Ownership Follows Live Work (release-on-complete + claim-on-spawn + double-dispatch recovery gate)

**Version / slug:** `ownership-follows-live-work`
**Date:** `2026-06-24`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/ownership-follows-live-work.md` (converged, approved, 11 frontloaded decisions)
**Second-pass reviewer:** independent Phase-5 review (the operator owns the trace/commit/PR ceremony)

## Summary of the change

Three independent gaps let the multi-machine `SessionOwnership` record drift from
where the live session actually is. This change makes the record self-correcting,
removing the stale-`active` cause PR #1258's reaper-closeout gate had to compensate
for. All three parts ride ONE dark flag `multiMachine.ownershipFollowsLiveWork`
(OMITTED from ConfigDefaults → `resolveDevAgentGate`: live-on-dev / dark-on-fleet).

Files added:
- `src/core/ownershipFollowsLiveWork.ts` — pure decision helpers (`shouldReleaseOnComplete`
  for Part A's gate incl. the FD9 session-identity guard; `planClaimOnSpawn` for Part
  B; `ownershipNonce` — the FD10 single collision-resistant nonce source). Single-
  sourced so the gate logic is unit-testable.
- `tests/unit/ownershipFollowsLiveWork.test.ts`, `tests/unit/ownershipFollowsLiveWork-recovery-gate.test.ts`,
  `tests/integration/ownership-follows-live-work.test.ts`, `tests/e2e/ownership-follows-live-work-lifecycle.test.ts`.
- `upgrades/next/ownership-follows-live-work.md` — release fragment (agent-only / experimental).

Files modified:
- `src/commands/server.ts` — (A) a new flag-gated `sessionComplete` listener wired
  INSIDE the durable-ownership block (the only scope where `ownReg`/`emitPlacement`/
  `_meshSelfId` are in lexical view — an anchor correction, see below) issuing a
  release CAS + the mandatory `emitPlacement`; (B) a hoisted
  `_claimOwnershipForAutonomousSpawn` helper called from the AutonomousLivenessReconciler
  `respawn` closure after a successful spawn; (D) Part-D deps wired into the
  SessionRecovery construction + the `recoverStuckMessages` per-topic owner skip; a
  shared `isOwnerReachableShared` helper used by BOTH Part-D gates.
- `src/monitoring/SessionRecovery.ts` — the Part-D recovery gate: new injected deps
  on `SessionRecoveryDeps` + the `decideOwnershipForRecovery` decision method +
  the forward/withhold/proceed handling at the top of `checkAndRecover`.
- `src/messaging/stuckMessageRecovery.ts` — the third Part-D site: an optional
  `ownerElsewhereReachable` dep that SKIPS (leaves untouched) a topic owned by a
  reachable peer.
- `src/core/types.ts` — the optional `multiMachine.ownershipFollowsLiveWork?: boolean`.
- `src/core/devGatedFeatures.ts` — the `DEV_GATED_FEATURES` registration.

## Anchor corrections (code-grounding discipline)

The spec's anchors were close but the code won in three places:
1. **Part A scope.** The spec said register the release handler "alongside the
   existing `sessionComplete` handler (server.ts:13247)" assuming `ownReg`/`_meshSelfId`
   were in scope there. They are NOT — they are declared in a nested try-block textually
   AFTER 13247. The handler is registered INSIDE that block (a session listener may be
   added at any init point); functionally identical, correct scope.
2. **`getSessionForTopic` returns a session NAME, not a Session.** The spec's Part A
   pseudocode read `liveForTopic.startedAt` off the result; the real method returns
   `string | null`. The implementation resolves the name to the running Session via
   `sessionManager.listRunningSessions()` and reads its `startedAt`.
3. **Part B/D scope.** Part B's claim is exposed via a hoisted helper so the respawn
   closure (defined before the ownership block) can reach it; Part D's deps are
   late-bound closures that read the registry/pool assigned later — both invoked at
   runtime, after wiring.

## Decision-point inventory

- **Added (Part A — authority):** a `release` CAS callsite on `sessionComplete`, gated
  by (a) flag+self, (b) owner===self & status active, (c) the FD9 session-identity
  guard. Fail-CLOSED on every uncertainty (withhold the release). Paired with the
  mandatory `emitPlacement('released')` (cas-emit-placement lint).
- **Added (Part B — authority):** a `place→claim` CAS pair on the autonomous respawn.
  NEVER force-claims a peer-owned topic (FD3). Fail-CLOSED (withhold + one neutral
  audit row on a post-gate owned-elsewhere race).
- **Added (Part D — SIGNAL, not authority):** a per-topic `ownerOf` read inside
  `checkAndRecover` + `recoverStuckMessages` that can ONLY ever WITHHOLD a local
  re-run / forward to the owner — never a new kill or send. Direction is MIXED and
  labeled per state: reachable-peer→forward (fail-closed), unreachable-peer incl.
  reachability-throw→withhold (fail-closed), null/self→proceed, ownerOf-throw→proceed
  (fail-OPEN, instrumented). No existing decision boundary is removed or weakened.

No new HTTP route, no new repeating loop (Part A fires once per completion event,
Part B once per spawn, the recovery gate is a one-shot pre-respawn check).

## Roll-up across the seven review dimensions

1. **Over-block**: none on the user channel. Part D can only WITHHOLD a local recovery
   re-run / forward it to the true owner — it never blocks a user message. Parts A/B
   withhold an ownership WRITE on uncertainty (the safe direction); a withheld release
   at worst leaves a stale `active` the existing reconciler + PR #1258 closeout still
   handle.
2. **Under-block**: none. No gate is loosened. Part B never force-claims; Part A never
   releases a record it can't prove is the completed work's; Part D's fail-OPEN branch
   is narrowly the registry-unreadable case (an already-broken state) and is counted.
3. **Level-of-abstraction fit**: correct. The A/B decision logic is single-sourced in a
   pure helper module (unit-testable); the CAS + emitPlacement pairing stays at the
   server wiring site where those deps live. Part D's decision lives in SessionRecovery
   (its deps are injected) with the primitives bound at server init.
4. **Signal-vs-authority compliance**: Parts A/B issue real AUTHORITY through the SAME
   guarded `SessionOwnershipRegistry.cas()` FSM at a fenced `epoch+1` (no new FSM
   transition, no new authority surface). Part D's `ownerOf` is a SIGNAL. Every new
   try/catch is either an `@silent-fallback-ok` best-effort observability path or a
   deliberate fail-closed/fail-open branch documented in code — complies with the
   no-silent-fallbacks posture (lint green).
5. **Interactions**: writes to the EXISTING replicated ownership lifecycle (same
   `emitPlacement` → coherence journal → OwnershipApplier path the user-move
   release/transfer already use), so a Part A release / Part B claim replicates exactly
   like today's releases. The `isOwnerReachable` signal is the SAME
   `machinePoolRegistry.getCapacity(owner).online` the router uses (shared helper — the
   two Part-D gates can't diverge). No new shared state.
6. **External surfaces**: NONE. No new endpoint, no egress, no third-party spend, no
   destructive fs/git action. The only new on-disk writes are append-only neutral audit
   rows to the EXISTING machine-local `logs/sentinel-events.jsonl` /
   `logs/autonomous-liveness.jsonl`. Single-machine agents are a strict no-op.
7. **Rollback cost**: low. Dev-gated dark on the fleet; a config flip force-darks even a
   dev agent. The flag OFF / single-machine path is byte-identical to today (locked by
   the flag-OFF regression tests across all three tiers). No migration needed (the flag
   is omitted from ConfigDefaults — the gate decides at runtime).

## Cross-machine / mixed-fleet note

The flag resolves PER-MACHINE, which is CORRECT here (unlike a transfer/placement
feature where half-activation strands a seat): each of A/B/D makes a strictly-MORE-correct
LOCAL decision (release a record we own, claim a record for a session we run, forward
instead of double-dispatch). A gate-ON machine self-corrects its own records; a gate-OFF
peer keeps today's (stale-prone) behavior — no torn/corrupt cross-machine state (each CAS
is fenced; a gate-OFF machine simply omits some releases/claims, which the existing
reconciler/applier already tolerate). During the mixed-fleet soak, PR #1258's
liveness-snapshot gate REMAINS the defense against a peer whose applier is lagged — which
is why its retirement is a SEPARATE, evidence-gated follow-up after the A/B soak, not
bundled here. This change does NOT touch `SessionReaper.ts` (PR #1258 owns it) or the FSM
transitions.

## Evidence pointers

- `npx tsc --noEmit` — clean.
- `npm run lint` — green (incl. `lint-cas-emit-placement`: 12 CAS sites all paired;
  `lint-dev-agent-dark-gate`; `lint-no-direct-destructive`; `lint-no-unbounded-llm-spawn`).
- New tests (66, all green): unit (26 + 10 + 3-added), integration (6), e2e (7).
- Legacy regression green: SessionOwnership, SessionOwnershipRegistry, SessionRecovery,
  the three session-reaper suites (PR #1258 area), OwnershipReconciler, OwnershipApplier,
  devGatedFeatures-wiring (validates the new dev-gated entry — 117 tests).
