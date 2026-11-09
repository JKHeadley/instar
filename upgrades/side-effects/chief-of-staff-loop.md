# Side-effects review — Chief of Staff PR 3: the check-in loop (wired, dev-gated)

**Spec:** docs/specs/chief-of-staff-topic.md §2.1–§2.9, §3, §4, §5 (converged, approved 2026-11-09). Builds on PR 1 (#2998, store) and PR 2 (#3000, action protocol).
**Tier:** 2 (an autonomous loop that starts work sessions; an LLM judge; the operator check-in lease; new routes).
**Change size:** new `src/core/ChiefOfStaffLoop.ts` (~520 LOC: config clamp, evidence hash + progress detection, verdict floors, due planning, note composition, the tick) and `src/core/ChiefOfStaffEvidence.ts` (~230 LOC: deterministic gather + metered judge); server wiring (loop construction behind the dev gate, the `startRun` executor, owner-renewal capture on the inbound Telegram hook, `operatorLeaseLive` + `actionGate` now derived from the loop); `/autonomous/register` carries `cosNoRespawn` + `idempotencyKey`; `spawnSessionForTopic` gains an `unlocked` option; routes `GET /chief-of-staff` and `GET /chief-of-staff/projects/:key`; `PostUpdateMigrator` owner-tunable defaults; `DP_COS_PROJECT_VERDICT` provenance row; component category. Tests: 2 unit files for the loop (27) and evidence (10), 1 wiring file (6), the protocol wiring file's darkness scan retargeted to "sole claimer", 1 integration (two real journals, real protocol, real Ed25519 renewals), 1 e2e (feature alive: 503 off / 200 on with a bound project).
**Effort:** build attempts 1; one ordering defect found by the integration test and fixed before commit (below).

## Summary

The Chief of Staff's tick. On the lease holder only, every `tickMinutes` (15 by default; owner-tunable, clamped), it folds the replicated store, derives the operator lease from signed renewal records, plans which bound projects are due (cadence, dirty marks, and a 30-minute gap after an owner message), and for each: **gathers** deterministic evidence (PRs merged since the last check, net diff on linked branches excluding generated files, run state, reconciler condition, live session, overdue commitments, conversation timestamps + a byte-bounded untrusted tail), hashes it, applies the **deterministic floors** (every deterministic done item passing ⇒ done-verified / claims-done; unchanged evidence ⇒ carry the previous verdict; owner newer than agent ⇒ waiting), consults the **judge** only when a question remains (one metered call, `chief-of-staff` budget, closed verdict set, citations must resolve to non-conversation evidence for stalled/drifting), **records the check-event and waits for its fsync**, then **acts** through PR 2's protocol (restart-run / restart-inject / redirect) within `restartsPerTick`, the restart-without-progress cap and the weekly breaker. Notes go out once per cadence at the owner's note time; immediate messages are capped per day. Everything it knows is a record in the store, so any machine folds the same answer and `GET /chief-of-staff` reads the same on every machine.

**Ordering defect found by the integration test, fixed here:** the first draft recorded the check-event AFTER claiming. The owner's action gate folds `newestCheckAgeMs` from the store, so the just-made check was invisible (not yet fsynced) and every first claim after a cadence was refused `lagging-fold`. The loop now records the check first, awaits `awaitDurableSeq` on it (new optional `awaitDurable` on the loop's journal seam, wired to `CoherenceJournal.awaitDurableSeq`), and only then claims — the §2.4 step 2(c) ordering the spec intends. The verdict the check records is final before the action (the done-candidate adjustments are pure), so no second check-event is needed.

## 1. Over-block
- The floors can only make the loop MORE conservative: `unknown` on an unreadable source, on an unresolvable citation, on a stalled/drifting verdict backed only by conversation text; `waiting-on-user` whenever the owner spoke after the agent. The cost of over-blocking is a missed restart for one cadence, surfaced as a "can't see" line after `unknownStreakForNote` consecutive unknowns.
- Lease paused ⇒ observe + note, no action. On a fresh install nothing has renewed, so the loop is paused until the owner speaks in the CoS conversation — which PR 4 creates. Until then the loop on a development agent observes only. Correct by design (§4), not an over-block.
- `restartsPerTick` (2) bounds blast radius per tick; `maxRestartsWithoutProgress` (3) parks; `breakerRestartsPerWeek` (5) trips. Each is owner-tunable within clamps.
No issue identified.

## 2. Under-block
- The judge's prompt wraps the tail as quoted untrusted data and the parser accepts only the closed verdict set, but a judge can still cite a non-conversation id for a verdict the evidence does not support; the floors cannot catch a wrong-but-well-formed verdict. Bounded by: an action is a restart of the project's OWN work (never a new scope), capped per tick / per project / per week, and every check records the cited ids so the owner can see why. The decision-quality meter grades restart verdicts by whether progress follows (identity rows recorded now via `DP_COS_PROJECT_VERDICT`; grading in the loop's later check).
- `evaluateDoneItem` in v1 handles `page <url> contains "<text>"` on a linked domain only; every other deterministic text reads `unknown`, which can never certify done. Narrow on purpose.
- Owner-renewal capture: the principal is the inbound event's verified Telegram user id compared with the configured owner id; content and relays never renew. A forged `renewal` record from a peer machine fails `verifyRenewal` (machine signature) on every reader.

## 3. Level-of-abstraction fit
The loop is the judgment layer the spec puts above PR 2's mechanics; it calls `claim()` and nothing else that has side effects. Evidence comes from the existing runners (authenticated `gh`, run store, reconciler, commitments, Telegram history) — no parallel readers. The judge rides the shared `LlmQueue` + intelligence router, with a provenance row like every other decision point. Notes ride `sendAutomationReply` / `sendToOwnerDM`.

## 4. Signal vs authority compliance
The judge is a SIGNAL. The deterministic floors and the protocol's invariants hold authority; the judge can only choose among verdicts the floors leave open, and a null judge (budget refused, provider down, unparseable) is `unknown` — never a fabricated verdict, never an action.

## 5. Interactions
- **Protocol:** `operatorLeaseLive` and `actionGate` are no longer stubs; the protocol's lagging-fold check now reads the loop's fold, which is why the check-before-claim ordering matters (above).
- **Run producers:** a CoS restart registers a run with `cosNoRespawn` so the heartbeat does not respawn it once the lease expires, and with `idempotencyKey` so recovery finds it.
- **Conversation lock:** the executor spawns through `spawnInteractiveSessionUnlocked` because `execute()` already holds the lock (not reentrant). `unlocked` is set ONLY on that path.
- **Inbound hook:** the renewal hook runs after the existing owner resolution, is a no-op unless the CoS topic id state key is set (PR 4), and never blocks or alters the message path.
- **Provenance census:** `ChiefOfStaffLoop` is registered as a `sentinel`; the ratchet's declare-or-fail check passes.

## 6. External surfaces
Two authenticated routes (503 where the feature is off; PIN-less reads of status only — no evidence text, no conversation content; the detail view lists evidence ids). The CoS-started session's first message carries the `[chief-of-staff automated — not operator words; key …]` header. Notes/immediates are sent only when a CoS topic exists or, when the group has more than one reader, to the owner's DM (§3 one-reader rule); with neither, the send throws and the items are re-queued.

## 6b. Operator-surface quality
No dashboard/app/console change in this PR (PR 4). The two routes are the data source for PR 4's surfaces.

## 7. Multi-machine posture (Cross-Machine Coherence)
Unified: the loop runs on the lease holder only (`holdsLease()`), every fact it produces (check-event, renewal, last-tick, lifecycle) is an immutable record in the replicated store, and the integration test proves that a second machine folds the identical project state, verifies the holder's signed renewal with the holder's public key, and that a tick on the non-holder writes nothing. The lease is derived from records, not from local memory, so a holder change carries the lease along. The per-tick PR cache is machine-local by design (a cache, rebuilt every tick; no fact lives only there).

## 8. Rollback cost
`chiefOfStaff.enabled: false` (or the fleet default) ⇒ the loop is never constructed: routes answer 503, the protocol's `operatorLeaseLive` falls back to `false`, the renewal hook is a no-op, no record is written. Records already written are inert events. The route/register/spawn additions are additive and unused without the loop.

## Found problems (triage)
- Check-before-claim ordering (above) → fixed here; it blocked the work.
- `evaluateDoneItem` covers one deterministic form → by design for v1; the spec's done-definition kinds beyond page assertions are PR 4/5 scope with the binding UI (tracked in the spec's maturation plan).

## Proportion
Tier 2, ~1,400 LOC incl. tests, 1 build attempt. In line with the judgment layer of a coordination feature.

## Second-pass review (Phase 5) and what changed because of it

Independent reviewer, 2026-11-09 14:08 PT: **"Concern raised: four MUST-FIX defects"** — all four fixed before commit, plus the SHOULD-FIX items that were small enough to close here; the two that are not are tracked commitments.

MUST-FIX (fixed):
1. **Un-judged `agent-may-certify` auto-closed a project.** `pendingJudgment` filtered judgment items to `owner-confirms`, so a checklist whose judgment items were all `agent-may-certify` closed as done-verified with no judge, no citation and no owner tap. Now every judgment item pends on the owner until a delegated judge exists (schema still accepts `certify`; it is not honoured). Test: `agent-may-certify ⇒ waiting-on-user, nothing closed, no mirror`.
2. **In-memory progress baseline.** `detectProgress` credited a "flip" against an in-memory map, so every process restart / holder change recorded spurious progress and reset `restartsWithoutProgress` (a durable cap became a per-restart cap). Now a check-event carries `doneItems` (schema + fold `lastDoneItems`), the baseline is the previous DURABLE check, and no baseline ⇒ no credit (P20). Tests: unit (no-baseline, fold-read baseline across loop instances) + schema.
3. **One-reader rule failed OPEN.** An unreadable group member count (`null`) sent to the forum topic; now `readers === null || readers > 1` ⇒ owner DM (spec §3 "failing closed to DM").
4. **Orphan run on spawn failure.** `startRun` registered the run then spawned; a throwing spawn left an `open` run record (CoS stood down for `maxRunHours`, retry hit the one-active-run 409, the reconciler could revive a run the CoS recorded `aborted`). Now the spawn is wrapped: on failure the run is marked `ended` (`cos-spawn-failed`) and the error carries the run id; `runRegistry.stopRun` is wired to `markTerminal` via a new public `AutonomousRunStore.findByRunId`.

SHOULD-FIX closed here: (5) no accepted/durable check-event ⇒ no action this tick (explicit return, not reliance on the owner's lagging-fold); (7) grace tick after a holder change, derived from the DURABLE `last-tick` records (newest tick by another machine ⇒ check but do not act), not from process memory; (8) the redirect text carries goal + remaining items + cited evidence ids, never the judge's free text; (10) a `routed` claim counts as a restart only when the owner reports `started`, and remote rejections (`lagging-fold`, `executor-failed`, …) reach the note as a can't-see line; (11) `_cosStandDownFor` also stands the Liveness Reconciler down for a `cosNoRespawn` run once the operator lease has expired; (12) an item with unknown age can no longer make stalled/drifting "fresh", and the owner/agent message items carry the read age (fresh) with the message time in the value, so a 30-hour-old last agent message is evidence OF staleness rather than stale evidence; (15) the note goes out on the first tick at or after the note hour.

Tracked, not in this PR (both fail to the safe side — under-notify / refuse — never to an action):
- **#6 process-local note queue + immediate cap** (a restart between an event and the note hour can drop a parked/finished/can't-see line; `immediateMessagesPerDay` is per process) → CMT-1416 "CoS: durable note queue + immediate cap", hard deadline 2026-11-16, PR 4.
- **#9 `settle()` after lease failover** (an intent claimed by a previous holder cannot be settled by the new holder; the conversation stays under `cos-intent-open` until the old holder returns) → CMT-1417 "CoS: settle an intent claimed by a previous holder", hard deadline 2026-11-16, PR 4.

Notes accepted as stated: the initiative mirror uses `InitiativeTracker.update` (bumps `lastTouchedAt`; a status-only method + per-tick reconcile is PR 4 scope); `ownerTap()` / `immediate()` and the `cos:unpark:` / `cos:confirm-done:` taps have no callers until PR 4's surfaces; `start()` reads `tickMinutes` once (a changed tick interval applies on restart; the other settings apply next tick); clock skew between machines beyond the 2-hour future tolerance shortens or pauses the lease and makes the owner refuse `lagging-fold` — the refusal now reaches the note (fix 10).

Correction to §7 above: the process-local state is the per-tick PR cache AND the note queue / immediate log / unknown streak / refutation count (tracked #6); every fact that gates an ACTION (checks, done-item baseline, intents, outcomes, renewals, last-tick) is a replicated record.

## Second-pass verdict
Concern raised and resolved: the four MUST-FIX items are fixed with tests, eight SHOULD-FIX items are closed in this PR, two are tracked commitments with dates. Reviewer's "checked and found sound" list (judge parser, null-judge ⇒ unknown, stalled/drifting citation floor, done-verified demotion, carry-forward, parked/breaker from the fold, unlocked spawn path, lock refs, bearer-gated routes, owner-side re-derivation of lease + gate) stands.
