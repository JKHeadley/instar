# Side-Effects Review — a planned restart keeps the lead

**Version / slug:** `planned-restart-keeps-lead`
**Date:** `2026-11-21`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`
**Spec:** `docs/specs/planned-restart-keeps-lead.md` (converged round 6 of 6, approved; report `docs/specs/reports/planned-restart-keeps-lead-convergence.md`)

## Summary of the change

A lease holder that restarts for a planned reason (role change, update, API/app/dashboard restart, Telegram fix command) lost the lead whenever its boot outlasted the lease TTL; on the Studio on 2026-11-21 that was a hand-back → role restart → lapse → takeover → hand-back loop (fb-135e3043-add, five restarts in 90 minutes). Now every in-process writer of `state/restart-requested.json` announces first (`src/core/restartRequestSignal.ts`); the holder's `LeaseCoordinator` opens a *restart episode*, renews with a bounded window as the expiry instead of the TTL, persists that renewal beside the lease (`state/lease-continuity.json`, signed, and a `pendingEpisodeId` marker on the local lease record) and broadcasts it. At boot such a *window lease* is not held from the local file: the self-fence stays "never confirmed" until a live peer's identity-verified answer shows no newer epoch (then the same epoch is renewed), a newer epoch is adopted, or every peer is dead/silent for boot claim safety's span (survivor hold). `MultiMachineCoordinator` subscribes to the announce, polls the request file every 2 s while holding, runs the renew tick at the pending cadence, waits in `initializeLease` for the reclaim verdict (up to 120 s), and exposes `syncStatus.pendingRestart`. The legacy single-url lease dial now sends a request nonce and records an identity-verified reply as `signed` for the boot hold. Switch: `multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.enabled` (rides the development-agent gate; `takeoverReadyPool.enabled: false` is the rollback). The boot side (rule 1b) is keyed on the disk state whatever the switch says.

## Decision-point inventory

- `LeaseCoordinator.openEpisode` / `pendingWindowMs`: when a renewal carries the window instead of the TTL (switch on AND an episode open).
- `LeaseCoordinator.evaluateEpisodeEnd` (pure, `LeaseContinuity.ts`): when the pending state ends (withdrawn; absent 60 s with no ledger row on a full read; consumed but alive past max(60 s, deadline+3 s+25 s); 4 h cap).
- `LeaseCoordinator.readWindowLeaseAtBoot`: whether the disk state is a window lease (continuity file that verifies and matches the store's epoch at a newer-or-identical nonce, or a store record with the marker), so the fence starts null.
- `LeaseCoordinator.evaluateReclaim`: confirmed (qualifying answer from a live peer in an evaluable round), superseded (newer epoch or live other holder), survivor hold (no live peer: every known peer presumed dead or settled silent by R1's own test), or wait.
- `resolveWindowMs`: base (slowest of last 20 boots + margin, or 3×TTL + margin), floor (TTL + margin), ceiling (min of TTL×min(ownN,6)−8 s, failoverThreshold−8 s, 10-min R1 ceiling), explicit `windowMs` override replaces only the base.
- `HttpLeaseTransport.legacyDial`: an identity-verified ack on the legacy dial is `signed` (was always `silent`).
- `ForegroundRestartWatcher.check`: one bounded wait per request for the holder's window renewal before consuming.
- `reconcileRole` (server.ts): single-flight around the now-async `requestRoleRestart`, re-evaluated after it settles.

## 1. Over-block

The boot side can withhold the lead longer than today: a window lease is not held until a peer confirms. Worst case on a healthy pool is one pull round (≤ 10 s); on a pool whose only peer is live but never answers verifiably (a peer on an older release with no ack), the boot waits 120 s then comes up standby and keeps asking every pull tick — the lapsed path takes over once the window expires (≤ 352 s on Echo), exactly today's behaviour one window later. A dark pool pays R1's silence span (45 s) and then holds. The 8 s wait the three hot writers add is bounded by the signal module's own deadline, so a slow or hung subscriber can never hold a writer. The `ForegroundRestartWatcher` wait is bounded the same way (deadline + 2 s) and runs once per request.

## 2. Under-block

A machine that dies mid-restart holds the pool for at most the window (233 s unmeasured on Echo, never above the thresholds after which peers already take over a silent holder). A process killed without a request (crash, power loss, kickstart) writes no episode and lapses as today — the spec names this residual and R5 owns it. An out-of-process request is seen by the 2 s poll and extended at once, but the supervisor's 10 s consumer could in principle consume before the first poll tick if the file appears < 2 s before its tick — then the lease lapses as today (no regression, one missed extension). A tampered continuity file is discarded; a tampered store record fails signature verification and is treated as no window lease.

## 3. Level-of-abstraction fit

Right layer: `LeaseCoordinator` is the one lease actor and already owns renewal/acquisition; the window is an ordinary renewal peers already verify and fold, so no wire change. The announce is a leaf module so every writer can import it without a cycle. `MultiMachineCoordinator` owns timers and the boot sequence, which is where the wait and the cadence belong. The pure pieces (window arithmetic, episode end rule, boot measurement) live in `LeaseContinuity.ts` so every boundary is unit-tested with a fake clock.

## 4. Signal vs authority compliance

No LLM authority anywhere. The decisions are deterministic protocol invariants over enumerable inputs (request file present/absent, ledger row present/absent/unreadable, probe outcomes, epochs and nonces). Each unmeasurable input has a stated safe reading: an unreadable or cut ledger reads as "row present" (keeps the episode open rather than dropping the window early), an unreadable store at boot is no window lease, a non-finite sample is discarded.

## 4b. Judgment-point check

The only competing-signal decision is the survivor hold (no peer answered vs. peers all dead/silent). It reuses boot claim safety's own classification (`classifyPeer` with R1's `silentProbes`/`silentSpanMs` and the unsigned-answer window) — the same evidence R1 already accepts for claiming the NEXT epoch — so it adds no new judgment, only reuses an existing one for keeping the current epoch.

## 5. Interactions

- Boot claim safety (R1, PR #3541): rule 1b sits before rule 1; a window lease that expired before boot falls through to rule 1 unchanged. R1's evidence log (`multiMachine.takeoverReadyPool`) gains three `fired` reasons and one `held`; the ladder entry is `composed` into the parent.
- `withdrawRoleRestart` (PR #3521) now announces the withdrawal so the episode ends at once.
- `LeaseHandbackReconciler`: unchanged; a kept lead means no hand-back is needed.
- `ServerSupervisor` and `ForegroundRestartWatcher` both still consume the file; the watcher waits once for the renewal, the supervisor is out of process and is covered by the 2 s poll's immediate extension.
- `PlannedRestartVerifyGuard` holds remain: a held request keeps the episode open (hourly log line, `held` evidence at 1 h, cap at 4 h = the consumers' 3 h + 1 h delivery bound).
- `requestSupervisedRestart` / `applyTeamSwitchHere` became async; every caller already accepted a promise (`routes.ts` ctx type, `teamRoutes`, `DesktopSetupTarget`) or was updated (`recipes.ts`, `recommendedServiceRoutes.ts`, the recommended-services wrappers and their pinned test text).

## 6. External surfaces

`/health` (authed) gains `multiMachine.syncStatus.pendingRestart` (`{requestedBy, since, windowMs} | null`). Config gains `multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.{enabled, windowMs}` (unseeded). Two new state files, registered (`state-coherence-registry.json`) and excluded from backup replication (`BackupManager`) and from the coherence manifest. Log sentences `lease-continuity: …`. `POST /server/restart` answers up to 8 s later while the lead is secured. The fix-command's request is normalised (plannedRestart, 1 h expiry, pid, bypassHolds). No new routes.

## 6b. Migration

n/a — no agent-installed file changes (no hook, skill or CLAUDE.md template edit). The awareness entry `server-restart-and-boot-readiness` is rebuilt for every agent on update by the registry; the config block is optional and unseeded.

## 7. Multi-machine posture

Machine-local by design (hardware-bound-resource): the continuity file and the restart budget describe THIS machine's own renewal and boots; a restored copy on another machine would name a machine it is not, so both are excluded from backups and git sync. Peers see only ordinary signed renewals. A mixed pool (one side on this release, one on the last) degrades to today's renewal on the unflagged side; the flagged side's longer expiry is folded by the old side exactly as any renewal. A version rollback within a window boots the old way once (the old code ignores the file and holds from the store record with the longer expiry, as pre-R1 did) — named in the release note.

## 8. Rollback cost

Config: `multiMachine.takeoverReadyPool.plannedRestartLeaseContinuity.enabled: false` (or `takeoverReadyPool.enabled: false`) stops every new extension at the next renewal; an open episode's window lease simply runs to its expiry (≤ 352 s on Echo). Code revert: the three async writers return to sync; no data migration (both state files are discardable; a stale `pendingEpisodeId` is ignored by old code and cleared by the first ordinary write). Rollback plan: revert the PR; delete `state/lease-continuity.json` and `state/restart-budget.json` on affected machines only if an old build logs confusion about them (it will not read them).

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action` — **closure: guard.** The two self-triggered loops this change adds (the holder's pending window renewal once per pending cadence while an episode is open, and the 2 s request-file poll with doubling backoff to 60 s) are registered as `planned-restart-lease-continuity` in `src/testing/selfActionRegistry.ts` and proven to settle by the ratchet `tests/unit/self-action-convergence.test.ts`: under a request that is never consumed the renewals keep their cadence (never faster) and stop at the episode's four-hour cap; the poll backs off to its ceiling and stays there. Their decisions are pure functions (`pendingRenewalDue`, `nextRequestPollMs` in `src/core/LeaseContinuity.ts`), and the episode end rule is the delegated give-up.
- Other classes touched: none. The boot reclaim is driven by the existing pull loop (already registered) and settles with its verdict; the announce is one-shot and writer-driven.

## Verification evidence

- `npx tsc --noEmit -p .` clean; `npm run lint:parallel` 55/55 steps passed.
- Unit: `tests/unit/LeaseCoordinator-plannedRestartContinuity.test.ts` 25/25 (includes the night's loop WITHOUT and WITH the fix), `tests/unit/LeaseContinuity.test.ts` 22/22, `tests/unit/restartRequestSignal.test.ts` 9/9, `tests/unit/HttpLeaseTransport-bootProbe.test.ts` 13/13 (one pinned expectation changed by design: legacy dial with a verified ack is `signed`).
- Existing lease suites rerun by name (27 files, 308 tests): green after that one change. Writer/watcher/wiring suites (14 files, 195 tests) green after awaiting the now-async `requestRoleRestart` in two tests.
- Integration: `tests/integration/planned-restart-lease-continuity.test.ts` 4/4 (real `HttpLeaseTransport` over HTTP, mesh and legacy dials).
- E2E: `tests/e2e/planned-restart-keeps-lead-boot-path.test.ts` 8/8 (real `MultiMachineCoordinator.initializeLease`, boot claim safety on and off, survivor hold, supersession, dark switch, production wiring by text); `tests/e2e/role-restart-wiring.test.ts` unchanged and green.
- Not run: a live two-machine drill (shared verifier machine, one test slot, operator asked for no server restart or live config change). Covered later by the parent's weekly takeover drill on a development agent.

## Second-pass reviewer

An independent reviewer subagent read the full diff against the spec (§1, §2, "The window"), every writer call site and the e2e text pin, ran `tsc` and the night's-loop unit file, and returned **DO NOT CONCUR as-is** with three should-fixes on stated safety invariants and several follow-ups. Every finding was fixed in this branch before the first commit, each with a test:

1. The local store kept an **unmarked long-expiry record** after an episode ended or was superseded (on a tunnel `renew()` never writes the store), so a crash in that stretch booted holding from the file for up to the window. Fix: `endEpisode` signs a TTL renewal, writes it to the store without the marker and broadcasts it; a superseded verdict force-expires the store's own window record (epoch floor kept).
2. The survivor hold used the configured liveness flag; with liveness off a stale registry counted as death. Fix: the dead set is used only with liveness on; otherwise "live" means every known peer not settled silent.
3. An observe-only boot with a window lease relinquished locally only. Fix: `relinquishAndBroadcast` (signed tombstone).
4. The spec's fold was missing (a git store never saw the file's window). Fix: the folded lease becomes `selfIssued` and seeds the nonce floor.
5. A window that lapsed during the wait closed as "superseded by self" with takeover evidence. Fix: a `lapsed` verdict with its own sentence and budget outcome.
6. The pending log sentence and `fired` evidence fired on every announcing machine. Fix: attached to the first pending renewal.
7. Nits: ledger coverage latched; ceiling applied after the floor; an expired marked record clears its marker; `requestRoleRestart` re-checks `stillNeeded` before writing; dead `notePublishSettled` removed.

The reviewer confirmed: no new two-holder path on the hot path (local store + tunnel), window caps and episode bounds correct, every async writer's call site awaits or accepts a promise, the `role-restart-wiring` pin holds, and write failures / missing transport methods / rollback all fail closed.
