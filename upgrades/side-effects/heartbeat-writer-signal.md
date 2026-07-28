# Side-Effects Review — Heartbeat-Writer Guard

**Version / slug:** `heartbeat-writer-signal`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent, autonomous session per Justin's direction)`
**Second-pass reviewer:** `adversarial reviewer subagent — narrow OBJECT on the promoteToAwake call site, APPLIED pre-commit (rollback-and-rethrow); all other probes CONCUR`

## Summary of the change

The multi-machine heartbeat writer's three call paths get three deliberate behaviors: (1) the 2-min timer tick and (2) the boot-immediate write go through `writeHeartbeatGuarded()` — try/catch + the new pure `FailureEpisodeLatch` (first-failure log once, ONE DegradationReporter signal per episode at 6min sustained, recovery log + re-arm, retries forever; declared Eternal Sentinel per P19); (3) `promoteToAwake`'s initial write is rollback-and-rethrow — a failed write aborts the promotion cleanly (`_role` + registry rolled back) instead of (pre-fix) dying mid-transition or (first draft) silently completing voiceless. Files: `FailureEpisodeLatch.ts` (new), `MultiMachineCoordinator.ts`, tests.

## Decision-point inventory

- 2-min tick + boot-immediate write — **modify (guarded)** — a write failure can no longer escape as uncaughtException (pre-fix: server FATAL crash on transient fs error); write cadence unchanged.
- `promoteToAwake` initial write — **modify (abort-clean)** — failure now rolls back role + registry and rethrows; pre-fix it threw AFTER flipping both (half-promotion).
- `FailureEpisodeLatch` — **add** — pure signal accountant, no authority.

## 1. Over-block

`promoteToAwake` now refuses to complete when the initial heartbeat write fails — the only "block," and it is the reviewer-mandated correct behavior: the alternative (silent voiceless promotion) invites a peer failover into dual-awake; the pre-fix behavior (throw after flipping role+registry) was a half-promotion. Failover paths that call promote with a genuinely broken disk now fail loudly at the transition where the operator can see it, with state consistent.

## 2. Under-block

(a) In heartbeat-only coordination mode (no lease attached — not the production default), a machine whose writes start failing AFTER a successful promotion serves voiceless until the 15min expiry triggers a peer failover; the dual-awake window is bounded by `shouldDemote` on the next check cycle, and the 6min signal precedes the horizon (reviewer probe 1 analysis — lease-attached mode resolves this via epochs regardless). (b) Three raw `writeHeartbeat()` calls remain in `machine.ts` CLI one-shots — no timer vector, errors surface to the CLI naturally (reviewer probe 2: no fix needed). (c) Consolidating the two earlier inline episode latches (lifeline supervisor; live-tail) onto `FailureEpisodeLatch` is deliberate follow-up, not this PR — refactoring just-merged code mid-series adds risk for zero behavior <!-- tracked: CMT-1109 -->.

## 3. Level-of-abstraction fit

`FailureEpisodeLatch` lands in core (importable by both core and lifeline consumers — the layering that blocked reusing the lifeline-resident sibling), as the canonical extraction of a pattern now shipped four times in one night per Friction-Is-a-Spec. The guard lives in the coordinator that owns the timer; `HeartbeatManager.writeHeartbeat()` itself stays throwing (CLI callers WANT the throw; the policy decision belongs to each caller, which is exactly what the three-site design encodes).

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No — the latch is a pure signal accountant. The behavioral changes are failure-HANDLING policy at existing call sites: the tick guard removes an accidental authority (a disk error crashing the server), and the promote rollback makes an existing implicit abort CONSISTENT (state no longer half-flipped). No new decision-maker.

## 5. Interactions

- **Crash vector closed:** the tick's throw → `uncaughtException` → `server.ts` FATAL path (fs errors are not in the non-fatal allowlist) — traced pre-fix; the guard removes it.
- **Signal-before-failover:** 6min threshold (3 failed 2-min cycles) < 15min `DEFAULT_FAILOVER_TIMEOUT_MS` expiry — operator hears before a peer acts (reviewer probe 3, verified at source).
- **DegradationReporter in the catch:** cannot throw back (console + in-memory push + best-effort-wrapped disk persist + fire-and-forget dispatch; reviewer probe 4); 10+ core files already use the singleton.
- **promoteToAwake consumers:** no test pinned the pre-fix throw-after-flip behavior (reviewer grep); coordinator suite (22) green.

## 6. External surfaces / 7. Rollback

Logs + one degradation record per episode; no API/schema/config/persistent state; no migration. Rollback = revert; the crash vector and the half-promotion return.

## Conclusion

The audit lead said "silent failure"; grounding found a crash vector — the verify-every-lead discipline paying again. The fix gives each of three call sites its correct failure policy, extracts the night's episode-latch pattern to its canonical reusable home, and was materially improved by the adversarial pass (the promote rollback) and by its own P19 test (the zero-sentinel bug, caught pre-ship).

---

## Phase 5 — Second-pass review (multi-machine role authority → required)

An adversarial reviewer probed: (1) the promotion semantics change — OBJECT: the first draft's guarded swallow in `promoteToAwake` silently completed a voiceless promotion; prescribed rollback-and-rethrow, APPLIED (with the registry rollback included, which even the pre-fix crash lacked); analyzed heartbeat-only vs lease-attached failover authority end-to-end; (2) remaining raw callsites — CLI one-shots only, safe; (3) 6min signal vs 15min failover horizon — verified at source; (4) DegradationReporter throw-safety in the catch — safe, precedented. Ran the latch + coordinator + leasePull suites and tsc — green/clean. **Verdict: CONCUR with the applied fix.**
