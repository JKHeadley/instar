# Spec — Multi-Machine Lease Robustness: git-less split-brain convergence + complete SQLite close-on-exit

**Status:** DRAFT — awaiting Justin's review (Tier-2: correctness/lifecycle fixes; spec-first)
**Author:** echo
**Date:** 2026-06-02
**Origin:** Surfaced live during the 12h multi-machine run (topic 13481) while rebuilding the throwaway laptop+mini test mesh. Two distinct, compounding bugs prevent stable holder election on git-less (source-tree) homes. Sibling spec to the approved `MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md` (Track E) and `MULTI-MACHINE-ROBUST-LEASE-PROPAGATION-SPEC.md` (the #674 active-pull demotion fix).

> Why a spec and not a PR: both fixes are correctness/lifecycle changes. #B touches process-exit teardown across 14 SQLite stores; #A changes lease-election convergence. Neither can be fully verified without a live two-machine repro, and a mistake in either degrades availability (shutdown data-loss, or a wrong-machine-awake). Per the tiered dev process these are Tier-2 — design approved first, then each built with tests.

---

## Problem A — git-less LocalLeaseStore same-epoch leapfrog split-brain

### Observed (live, 2026-06-02)
Two throwaway agents (laptop `mmtest2-laptop` :4050, mini `mmtestmini` :4047), both v1.3.196, source-tree homes → git-less `LocalLeaseStore` (`.instar/lease-local.json`). After a teardown in which each had run solo, each machine's local store held its OWN lease claiming ITSELF holder:
- laptop `lease-local.json`: `holder=m_8f06… (laptop), epoch 634`
- mini `lease-local.json`: `holder=m_8aa1… (mini), epoch 635`

On restart, `/health` syncStatus showed `splitBrainState: "contested"`, `awakeMachineCount: 2`, with the epoch climbing (632→634→635→…). The server logs on both sides showed `[MultiMachine] lease-pull: same-epoch contested lease — peer … claims epoch N while we hold epoch N (near-silent split-brain signal)` repeatedly. The two never converged to a single holder.

### Root cause
The HTTP active-pull (#668) makes a machine pull the peer's lease and reconcile. But when BOTH machines already hold a self-granted lease, each one keeps RENEWING its own lease (incrementing epoch on each heartbeat) at least as fast as it adopts the peer's — so they leapfrog. There is no shared arbiter (git substrate) to break the tie, and the local renewal path does not yield to an observed competing peer lease. This is the source-tree-homes gap (distinct from Track D's git-substrate path): a clean single-holder start converges (proven a prior session), but a post-teardown state where both believe they are holder does not.

### Proposed fix
Make local renewal YIELD to an observed competing peer lease, so the leapfrog terminates deterministically:
1. **Deterministic tie-break on equal epoch.** When a machine observes a peer lease at the SAME epoch as its own (the "contested" signal), do NOT keep renewing blindly. Resolve the tie by a stable, machine-independent comparator (e.g. lexicographically lower `machineId` wins, already the `effectiveView()` tie-break direction per `LeaseCoordinator`), and the LOSER immediately steps down to standby and STOPS self-renewing until it can acquire at a strictly higher epoch via the normal path.
2. **Adopt-higher-epoch-before-renew.** Before a heartbeat renews the local lease, pull/observe the peer; if the peer holds a strictly higher epoch, adopt it (become standby) instead of renewing — never renew "downhill" past a fresher peer.
3. **Bounded contested escalation.** If contested persists past K reconcile cycles (already partially surfaced as the near-silent split-brain signal), surface ONE deduped Attention item ("two machines contesting the lease — demote machine X?") rather than logging every tick (the existing near-silent path already exists; this just bounds it).

### Test plan (unit, no live mesh needed)
- Two `LocalLeaseStore`s + two `LeaseCoordinator`s wired through an in-memory bidirectional transport, each seeded with a self-granted lease at the SAME epoch → assert that after N reconcile cycles exactly one is awake (`awakeMachineCount===1`, `splitBrainState` clears), and it is the deterministic tie-break winner.
- Seeded at DIFFERENT epochs → assert the higher-epoch machine wins and the lower steps down without leapfrogging (epoch does not climb unboundedly).
- Regression: a clean single-holder start still converges (don't break the proven path).

---

## Problem B — incomplete SQLite close-list → "mutex lock failed" SIGABRT on process.exit()

### Observed (live, 2026-06-02)
Under the Problem-A contested churn, the holder process exited and crash-looped. macOS crash report (`~/Library/Logs/DiagnosticReports/node-*.ips`): `SIGABRT` / `Abort trap: 6`, faulting thread 0 → `node::Environment::Exit` (a JS `process.exit()`), then during C++ teardown `__cxa_finalize_ranges → exit` a static destructor's `std::mutex` lock fails → `std::system_error: mutex lock failed: Invalid argument` → `std::terminate` → abort.

### Root cause
This is a KNOWN class: the codebase already documents it (`src/commands/server.ts` ~10093: *"Close SQLite databases before exit — prevents 'mutex lock failed' crash when better-sqlite3 destructors fire during process teardown"*) and works around it for `ForegroundRestartWatcher` (`exitOnRestart:false` → graceful shutdown) and in the `uncaughtException` handler. BUT the close-list is INCOMPLETE: the graceful `shutdown` and the `uncaughtException` handler close only `topicMemory` and `semanticMemory`. The codebase has **14** distinct better-sqlite3 stores (`PendingRelayStore`, `TokenLedger`, `CorrectionLedger`, `FeatureMetricsLedger`, `FailureLedger`, `FrameworkIssueLedger`, `MessageProcessingLedger`, `StopGateDb`, `SpawnLedger`, relay `RegistryStore`, `PreferenceStore`, task-flow store, iMessage `NativeBackend`, …). Any of those left open when `process.exit()` fires still triggers the static-destructor mutex abort. So under any fatal exit while those stores are open, the process aborts instead of exiting cleanly — and on a crash-loop, never recovers.

### Proposed fix (structural — Structure > Willpower)
A central **SQLite close registry** so the close-list can never be incomplete or forgotten:
1. A tiny module (e.g. `src/core/SqliteRegistry.ts`) exposing `registerSqliteHandle(closeFn): unregisterFn` and `closeAllSqlite()`. Each store registers its `() => this.db.close()` in its constructor and unregisters in its own `.close()`.
2. All process-exit paths (`shutdown`, the `uncaughtException` handler, the last-resort handler) call `closeAllSqlite()` immediately before `process.exit()`. Idempotent + best-effort per handle (a throwing close must not block the others).
3. Keep the explicit `topicMemory/semanticMemory` closes for belt-and-suspenders, but the registry is the guarantee.

This makes the property structural: a NEW sqlite store added later is closed on exit automatically by registering, instead of relying on someone remembering to extend a hand-maintained list (the exact failure mode that produced this bug).

### Test plan (unit, no live mesh needed)
- Register N fake handles → `closeAllSqlite()` closes ALL, in any order; a handle whose close throws does not prevent the others closing; unregister removes a handle.
- Wiring-integrity: assert each of the 14 stores calls `registerSqliteHandle` in its constructor (grep-style or instantiation test) and unregisters on `.close()`.
- Lifecycle: a server shutdown closes every registered handle exactly once (spy).

### Migration / risk notes
- Pure in-process; no config/route/schema change; no migration needed (ships in code, reaches existing agents on normal update).
- Risk is in the shutdown path: a regression could double-close or block shutdown. Mitigated by best-effort per-handle + idempotency + the existing explicit closes retained.

---

## Sequencing
1. **B first** (the crash is what makes A un-observable — a crash-looping holder can never win the lease). Land B, redeploy the throwaway mesh, confirm no SIGABRT under contention.
2. **Then A** — with a stable (non-crashing) holder, implement + verify the deterministic convergence, then prove live failover (Track E) on the rebuilt mesh.
3. Each ships as its own gated PR with the unit tests above; live two-machine verification after both land.

## Out of scope
- Track D (git-substrate split-brain) — separate, already specced.
- The §7b real-Telegram test-as-self — proceeds after A+B give a stable mesh.
