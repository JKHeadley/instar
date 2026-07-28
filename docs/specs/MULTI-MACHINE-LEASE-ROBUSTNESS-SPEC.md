---
title: "Multi-Machine Lease Robustness — git-less split-brain convergence + complete SQLite close-on-exit"
slug: "multi-machine-lease-robustness"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "multi-machine-lease-robustness.eli16.md"
supervision: "tier0"
lessons-engaged:
  - "Structure > Willpower — the SQLite close-list is a structural registry, never a hand-maintained list"
  - "P4 Wiring-Integrity — a test asserts every store registers + the allowlist matches the real callsite count"
  - "L6 — exit-path completeness: closeAllSqlite covers EVERY process.exit() callsite, ordered last after writer-stops"
  - "P7 LLM-Supervised Execution — tier0 (pure deterministic lifecycle/consensus code, no LLM)"
  - "Convergence-before-build — spec-converge caught that Problem A as first written does NOT converge (zombie-holder); corrected before any code"
review-convergence: "2026-06-02T12:07:12.665Z"
review-iterations: 3
review-completed-at: "2026-06-02T12:07:12.665Z"
review-report: "docs/specs/reports/multi-machine-lease-robustness-convergence.md"
approved: true
approved-by: "echo (self-approved under Justin's standing preapproval — topic 13481, 2026-06-02 12h autonomous session: 'You have my preapproval for any development you need to do as long as you proceed carefully and use spec convergence and cross model review as appropriate'; 3 convergence rounds run, design independently verified, empirical proof is the Problem-A convergence unit test)"
cross-model-review: "unavailable"
cross-model-review-reason: "codex CLI not installed in this environment (recorded honestly, not fabricated); 3 internal rounds + independent verification + Problem-A convergence unit test as empirical proof"
---

# Spec — Multi-Machine Lease Robustness: git-less split-brain convergence + complete SQLite close-on-exit

**Status:** DRAFT — for spec convergence (Justin's standing preapproval); Tier-2 correctness/lifecycle fixes
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

### Proposed fix (CORRECTED after convergence Round 1 — the prior "stop renewing" did NOT converge)

**Why the obvious fix fails (code-verified).** A loser that merely "stops self-renewing" stays a **zombie-holder**: `holdsLease()` judges a holder's own expiry on its **monotonic-local clock** (`LeaseCoordinator` §L−1), so it still believes it holds its own lease for a full `ttlMs` after it stops renewing. Meanwhile the winner, already holding at epoch N, only **renews N** — it never calls `buildAcquisition`, which is the *sole* path that advances to N+1 (`FencedLease.ts:215`, "may only ever write epoch = currentEpoch + 1") — so it never fences the loser. Both sit at N: no single-holder fixpoint. (Also: the cited `effectiveView()` tie-break comparator does NOT fire on the git-less same-epoch path — a real comparator must be ADDED there.)

**The convergent fix — loser relinquishes AND winner advances ONCE (both are required).** *Round 2 caught that "loser relinquishes, winner stays at N" still fails: `effectiveView()`'s tunnel-fold adopts a peer lease only on a STRICT `>` epoch, so a same-epoch (N) winner is never adopted → the loser goes headless and no one holds. The winner MUST advance to a strictly-higher epoch for the loser to adopt it; and the loser MUST relinquish first so the winner's `canAcquire()` is not blocked by the same-epoch live peer.*
1. **Deterministic equal-epoch tie-break (ADD it).** On the "contested" signal (active-pull #668 observes a peer lease at the SAME epoch as this machine's self-issued lease), resolve by a stable comparator — lexicographically lower `machineId` wins. ADD this comparator to the git-less reconcile path; it is not the existing `effectiveView()` behavior here. Both machines compute the SAME winner (deterministic), so exactly one relinquishes and exactly one advances.
2. **Loser relinquishes — to UNBLOCK the winner and go headless.** The loser CLEARS its own `selfIssued` AND forces its **persisted** `lease-local.json` lease to read as expired (not waiting for the monotonic TTL). Two effects: (a) it stops being a "live peer at epoch N", so the winner's `canAcquire()` no longer returns `held-by-live-peer` and the winner can advance; (b) `holdsLease()` returns false so it reconciles to standby. **Latched:** the relinquish is one-shot per contested episode — the loser must NOT re-clear+re-acquire every ~5s tick (guard with a per-episode flag, else churn).
   - **Concrete API the build adds (names the behavior above so the build target is unambiguous):** a new `LocalLeaseStore.forceLocalExpiry()` (clears `cached` AND rewrites the persisted `lease-local.json` self-record so `read()` returns an expired/non-holding view — the existing `read()` returns `cached` and `casWrite` rejects `epoch<=committed`, so a *dedicated* relinquish method is required; `persist()` is private today) invoked by a new `LeaseCoordinator.relinquish()` that also sets `selfIssued = null`. This is the missing piece every Round-3 reviewer correctly flagged as "no path to relinquish exists" — the build creates it. The winner-advance is likewise a NEW code path: the contested branch, on determining THIS machine is the winner and observing the loser has relinquished (peer no longer a live holder), calls `buildAcquisition` ONCE — distinct from `tickLease`'s `renew()`/`acquireIfEligible()`, which only renew the same epoch and would never advance N→N+1 on their own.
3. **Winner advances ONCE to N+1 (the unambiguous fix).** Once the loser has relinquished, the winner calls `buildAcquisition` → epoch N+1 (`FencedLease.ts:215`), establishing a strictly-higher, signed lease. This is ONCE per contested episode (a tie-resolution), NOT a per-tick bump → no leapfrog. The loser's next pull observes the winner@N+1; `N+1 > N` passes the strict-`>` tunnel-fold → the loser ADOPTS it (standby, holder = winner). **Converged:** single holder at N+1, epoch stops climbing.
4. **Adopt-higher-epoch routes through the auth guard.** Adopting an observed higher-epoch peer lease MUST go through `acceptTunnelLease`'s signature + nonce + monotonic-floor verification, so a forged/replayed peer lease can never demote a live holder.
5. **The loser→standby→read-only path is survivable (hard precondition).** Demotion sets `StateManager` read-only (`MultiMachineCoordinator` standby enforcement); a stray write then throws "StateManager is read-only". #673 (already on main) added that message to `isNonFatalUncaught`'s allowlist (`uncaughtExceptionPolicy.ts:41`), so it is CAUGHT, not fatal. The rewrite makes this an explicit dependency and regression-tests it (drive a loser to standby under concurrent write load; assert the process does NOT exit).
6. **Bounded contested escalation.** If contested persists past **K** reconcile cycles (default K=5) — i.e. the relinquish+advance did NOT converge (a genuinely stuck/partitioned peer) — surface ONE Attention item with a DETERMINISTIC recommendation ("demote machine X" = the tie-break loser, not a raw Y/N), deduped by a key that SURVIVES the leapfrog — the unordered `{machineIdA, machineIdB}` pair + contested-episode start, NOT the epoch (which changes each tick). **Hook point:** this is a NEW path distinct from the existing `checkForUnresolvableSplit` (which handles a reachable-but-unmovable partition); name it explicitly and wire the K-cycle counter in `tickLeasePull`'s contested branch, reusing the same Attention-dedup store.

### Test plan (unit, in-memory two-coordinator harness — no live mesh)
- Both seeded with a self-granted lease at the SAME epoch N → after bounded cycles assert a STABLE FIXPOINT with ALL of:
  - exactly one machine reports `holdsLease() === true`, and it is the lower-`machineId` winner;
  - **BOTH machines' `currentHolder()` name the winner** — critically, the LOSER's `currentHolder()` must equal the winner, NOT itself and NOT null/headless (this is the assertion that distinguishes true convergence from the "headless loser" failure mode Round 2 caught: a loser whose `holdsLease()` is false but whose `currentHolder()` still names its own stale local-store record is a quieter split-brain, not convergence);
  - the converged epoch is exactly **N+1** (the winner advanced ONCE), and on the next cycle the epoch STOPS climbing (no per-tick bump);
  - `awakeMachineCount === 1` AND `splitBrainState` clears (these are necessary but NOT sufficient on their own — assert them in addition to, not instead of, the `currentHolder()` agreement above).
- **Loser does not re-trigger contested on the winner:** after convergence, when the winner next pulls the loser, the loser reports `holder=winner@N+1` so `peer.holder === self` on the winner → `surfacePullDiscoveredSplitBrain` does NOT re-latch `leasePullContested`.
- **Loser re-entry:** after convergence, restart/re-acquire the loser → assert NO fresh leapfrog (it adopts the winner, or acquires only at a strictly-higher epoch once the winner's lease genuinely expires).
- DIFFERENT epochs → higher-epoch machine wins, lower adopts (no climb).
- **Forged/replayed** peer lease at a higher epoch → REJECTED by the signature/nonce/floor guard; the live holder is NOT demoted.
- **Read-only survivability** regression: a loser demoted under concurrent write load does NOT exit (depends on #673).
- **3+ machine same-epoch tie:** seed THREE coordinators all at epoch N → assert the lower-`machineId` **total order** resolves the N-way tie to the single global-minimum winner (the comparator is a total order, so transitivity A<B ∧ B<C ⇒ A<C holds — no non-transitive cycle), the two non-winners BOTH relinquish, the winner advances ONCE to N+1, and all three `currentHolder()` agree on the winner. No leapfrog among the losers.
- Regression: a clean single-holder start still converges (don't break the proven path).

---

## Problem B — incomplete SQLite close-list → "mutex lock failed" SIGABRT on process.exit()

### Observed (live, 2026-06-02)
Under the Problem-A contested churn, the holder process exited and crash-looped. macOS crash report (`~/Library/Logs/DiagnosticReports/node-*.ips`): `SIGABRT` / `Abort trap: 6`, faulting thread 0 → `node::Environment::Exit` (a JS `process.exit()`), then during C++ teardown `__cxa_finalize_ranges → exit` a static destructor's `std::mutex` lock fails → `std::system_error: mutex lock failed: Invalid argument` → `std::terminate` → abort.

### Root cause
This is a KNOWN class: the codebase already documents it (`src/commands/server.ts` ~10093: *"Close SQLite databases before exit — prevents 'mutex lock failed' crash when better-sqlite3 destructors fire during process teardown"*) and works around it for `ForegroundRestartWatcher` (`exitOnRestart:false` → graceful shutdown) and in the `uncaughtException` handler. BUT the close-list is INCOMPLETE: the graceful `shutdown` and the `uncaughtException` handler close only `topicMemory` and `semanticMemory`. The codebase has **14** distinct better-sqlite3 stores (`PendingRelayStore`, `TokenLedger`, `CorrectionLedger`, `FeatureMetricsLedger`, `FailureLedger`, `FrameworkIssueLedger`, `MessageProcessingLedger`, `StopGateDb`, `SpawnLedger`, relay `RegistryStore`, `PreferenceStore`, task-flow store, iMessage `NativeBackend`, …). Any of those left open when `process.exit()` fires still triggers the static-destructor mutex abort. So under any fatal exit while those stores are open, the process aborts instead of exiting cleanly — and on a crash-loop, never recovers.

### Proposed fix (structural — Structure > Willpower)
A central **SQLite close registry** so the close-list can never be incomplete or forgotten:
1. `src/core/SqliteRegistry.ts`: `registerSqliteHandle(closeFn): unregisterFn`, `closeAllSqlite()`, and `__resetSqliteRegistryForTests()`. The registry tracks a **closed set** so a handle is invoked **at most once** even if both the registry and an explicit close target it. `__resetSqliteRegistryForTests()` MUST clear BOTH the handle list AND the closed-set, so test-isolation does not leak an "already closed" verdict from one test into the next (a half-reset would make a handle registered in test N+1 appear pre-closed).
2. **Register AFTER the db is open; unregister BEFORE the explicit close.** Each store registers `() => this.db.close()` only once its `db` is fully constructed (never before — avoids use-after-partial-construct), and its `.close()` calls the returned `unregisterFn` **before** `this.db.close()` so the registry no longer holds it → no double-fire. Each store's `.close()` is itself idempotent via a `closed` flag (note: `StopGateDb.close()` lacks this guard today — add it).
3. **Re-enumerate ALL stores precisely (the count was wrong — ~14–17 across reviewers).** The build greps every `new Database(` / `better-sqlite3` callsite, defines the registry-coverage allowlist, and a wiring-integrity test asserts the allowlist matches the actual callsite count and that every store registers. Known set: PendingRelayStore, TokenLedger, CorrectionLedger, FeatureMetricsLedger, FailureLedger, FrameworkIssueLedger, MessageProcessingLedger, StopGateDb, SpawnLedger, relay RegistryStore, PreferenceStore, task-flow store, iMessage NativeBackend, topic/semantic memory — **count + confirm at build time**.
4. **Close ORDER + timing.** `closeAllSqlite()` runs as the **LAST** step before `process.exit()` on EVERY exit path — AFTER `server.stop()` + `scheduler.stop()` + all writer-stops (so no later tick re-opens a statement on a closed db) and AFTER any WAL checkpoint / `sharedStateLedger.shutdown()` flush (so no unflushed write is lost). Enumerate ALL `process.exit()` callsites (graceful `shutdown`, `uncaughtException`, the last-resort handler, `ForegroundRestartWatcher`) and route each through `closeAllSqlite()` first; add a re-entrancy guard to the graceful `shutdown` handler.
5. **Drop the redundant explicit `topicMemory`/`semanticMemory` closes** once they self-register — the "belt-and-suspenders" double-close IS the double-close hazard. (Or keep them only if unregister-on-explicit-close provably removes them from the registry first.)

Structural: a NEW sqlite store added later is closed on exit automatically by registering — no hand-maintained close-list to fall behind (the exact failure mode that produced this bug).

### Test plan (unit, no live mesh needed)
- Register N fake handles → `closeAllSqlite()` closes ALL in any order; a throwing close does not block the others; unregister removes a handle; **a handle is invoked AT MOST ONCE** (explicitly close a store, then call `closeAllSqlite()`, assert close fires exactly once total).
- Wiring-integrity: every store in the allowlist registers in its constructor + unregisters on `.close()`; the allowlist matches the actual `new Database(` callsite count (fails if a new store is added without registering).
- Lifecycle/ordering: a server shutdown closes every registered handle exactly once, and `closeAllSqlite()` is the last pre-exit step (after writer-stops).
- Test-isolation: `__resetSqliteRegistryForTests()` clears the process-global between tests.

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
