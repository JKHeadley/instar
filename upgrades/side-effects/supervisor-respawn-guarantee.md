# Side-Effects Review — Supervisor Respawn Guarantee (net #2)

**Version / slug:** `supervisor-respawn-guarantee`
**Date:** `2026-06-14`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer — Concur with the review (2026-06-14)`

> Second-pass verdict: **Concur.** Verified no double-spawn (5s first backoff < 10s tick; `spawnServer` kills any lingering session; circuit breaker bounds a crash-loop), no boot regression (`spawnServer` creates the tmux session synchronously via `execFileSync` before the loop arms, so a booting server always has a live session), correct ordering after the slept short-circuit and planned-restart suppression, stale `spawnedAt` does not corrupt the `lastHealthy < spawnedAt` bind-failure tracker, and `firstSpawnedAt` is anchored/cleared on all healthy paths. One non-blocking edge raised — a long hard-sleep while `firstSpawnedAt` is anchored could make the wall-clock ceiling fire immediately on the post-wake boot — **hardened in response:** a genuine (low-load) suspend/wake now re-anchors `firstSpawnedAt = now` in both the gap-check and the `SleepWakeDetector` wake handler (a real wake is a fresh boot episode), with two added regression assertions.

## Summary of the change

`src/lifeline/ServerSupervisor.ts` — the in-process net that detects a dead server and respawns it. Three fixes, all in the 10s health-check loop, closing the 2026-06-14 ~2h outage where a CPU-starved box made the supervisor misread its own stalled event loop as a machine sleep/wake, reset `spawnedAt = now`, and pin itself in the startup-grace branch where health failures (including a vanished server tmux session) are ignored.

- **Fix A (load-bearing):** at the top of each tick, before the startup-grace early-return, probe `isServerSessionAlive()`. A missing session is unambiguous death → call `handleUnhealthy()` immediately (subject to its existing circuit-breaker / restart-attempt accounting), regardless of any grace pin.
- **Fix B:** make the gap-based sleep/wake detection (and the `SleepWakeDetector` `'wake'` handler) load-aware. A large inter-tick gap while `loadRatioProvider() > maxLoadRatio` (1.5) is classified as a stalled event loop, not a suspend — failure counters reset (safe) but `spawnedAt` is NOT reset (grace not re-armed). A low-load gap still re-arms grace (real-suspend behavior preserved).
- **Fix C:** an absolute grace ceiling — `firstSpawnedAt` anchors the first spawn of the current not-yet-healthy episode (never reset by sleep/wake handlers); cumulative grace is capped at `startupGraceMs × 3`. Cleared on the first healthy tick.

Refactor: the inline `setInterval` callback was extracted verbatim into `private async runHealthTick()` so a single tick can be unit-driven and the wiring-integrity test can assert the loop probes session liveness.

## Decision-point inventory

- `ServerSupervisor.runHealthTick` missing-session override (Fix A) — **add** — respawn-vs-wait decision now grounded in "does the tmux session exist?" before grace.
- `ServerSupervisor.runHealthTick` gap classification (Fix B) — **modify** — sleep/wake-vs-stalled-loop decision now consults load.
- `SleepWakeDetector 'wake'` handler `spawnedAt` reset (Fix B) — **modify** — same load guard.
- `ServerSupervisor.runHealthTick` grace early-return (Fix C) — **modify** — adds the absolute ceiling term.

---

## 1. Over-block

No outbound/inbound message block surface. The analogous "over-action" risk is **respawning a server that should have been left alone** (a false positive). Fix A only acts when the tmux session is genuinely absent; a normally-booting server has a live session (created synchronously at spawn; HTTP binds later), so a real boot is never killed — covered by the regression test "alive booting session is still given full grace." Fix B is strictly *less* aggressive than the prior code (it withholds a `spawnedAt` reset; it never adds a kill). Fix C only fires after 3× the (already generous 10-min) grace with the session never having gone healthy — a genuinely hung boot, not a slow one.

## 2. Under-block

The "under-action" risk is **a dead server that still isn't respawned**. Remaining gaps, explicitly: (a) Fix A respawns only when the *server tmux session* is missing — a server process that is alive-but-wedged is still handled by the pre-existing `evaluateUnhealthyServer` path (unchanged), with its CPU-starvation defer; this PR does not change that path. (b) This is net #2 only — net #1 (a subsystem uncaught exception crashing the whole process) and net #3 (the fleet watchdog / launchd-level backstop) are tracked follow-ups in the spec §6 (FU-1, FU-2). <!-- tracked: CMT-1540 --> Net #3 was additionally found and fixed LIVE on the echo laptop this session (its launchd job was loaded from a reaped temp-dir plist → exit 127); the durable source fix is tracked in FU-2.

## 3. Level-of-abstraction fit

Correct layer. The supervisor legitimately holds respawn **authority**; this change makes that authority *more reliable* by grounding the decision in an objective fact (session exists?) rather than a fragile inference (did the machine sleep?). It reuses the existing low-level primitives (`isServerSessionAlive`, `handleUnhealthy`, `loadRatioProvider`, `maxLoadRatio`) rather than re-implementing them — Fix B uses the *same* load signal the CPU-starvation defer and `SleepWakeDetector` already use. No new gate is introduced; no redundant config knob added (reused `maxLoadRatio = DEFAULT_MAX_LOAD_RATIO = 1.5`, which is exactly the spec's named `cpuStarvationLoadPerCore` default — a deliberate DRY decision vs. the spec's suggested new knob, since the value and signal are identical).

## 4. Signal vs authority compliance

Compliant. Per `docs/signal-vs-authority.md`: the heuristic (sleep/wake inference) is *demoted* to where it is safe — leniency for an *existing* slow process — and can never suppress recovery of a *missing* process. The authoritative respawn decision is moved onto a non-heuristic structural fact (tmux session existence). This is the correct direction: replace willpower/heuristic with structure. No brittle check is given new blocking authority.

## 5. Interactions

- **Does not shadow / is not shadowed:** Fix A runs *before* the grace early-return and `return`s on a missing session, so the rest of the tick is skipped on that path (intended — respawn is scheduled). The existing non-grace `evaluateUnhealthyServer` missing-session branch is unchanged and still covers the alive-but-unresponsive case.
- **Double-fire / hot-spin:** Fix A routes through `handleUnhealthy()`, which carries the full circuit-breaker, restart-attempt cap, cooldown, and planned-restart suppression. During the post-`handleUnhealthy` backoff (first attempt 5s < 10s tick) the session re-appears before the next tick, so no double-spawn; a genuine crash-loop trips the breaker exactly as today. Planned-restart / legacy-restart / slept-marker short-circuits all still precede or are honored by `handleUnhealthy`.
- **Counter resets:** Fix B still resets failure counters on a starved gap (safe — they may be stale); it only withholds the `spawnedAt`/grace re-arm. Fix C clears `firstSpawnedAt` on both healthy paths (grace optimistic-probe success and the main healthy branch).

## 6. External surfaces

No API route, no message, no cross-agent surface, no schema change. Pure in-process lifeline behavior. Adds console log lines on the new branches (forensic only). No dependency on conversation state. The only timing dependency is system load (`os.loadavg()`), already used elsewhere and injectable in tests.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The `ServerSupervisor` supervises THIS machine's server process; each machine runs its own supervisor and respawns its own server. There is no shared state, no replication, and no cross-machine read — a server's liveness is inherently a per-machine fact. Nothing here is user-facing (no one-voice gating needed), nothing is durable state that could strand on a topic transfer, and no URL is generated. This is the correct posture, not a silent single-machine assumption.

## 8. Rollback cost

Low. Pure code change in one file + one new test file; no migration, no state schema, no config default change. Back-out = revert the commit and ship a patch release; the supervisor reverts to prior behavior with no data repair. The extracted `runHealthTick()` is behavior-identical to the prior inline callback, so even a partial revert is clean. The change only makes recovery *more* likely to fire, so the failure mode of a bug here is bounded by the pre-existing circuit breaker.
