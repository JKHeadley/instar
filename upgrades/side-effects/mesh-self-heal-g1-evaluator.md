# Side-Effects Review — Mesh Self-Heal G1 (zombie-relinquish evaluator)

**Change:** The FINAL G1 piece (MESH-SELF-HEAL-SPEC §3.1) — `MultiMachineCoordinator.evaluateZombieRelinquish()` wired into `tickLease()`'s HOLDER branch (after renew). HIGH-RISK: it makes a holder GIVE UP the fenced awake-lease when its three machine-local liveness watermarks go stale. Ships DARK + dryRun-first behind `multiMachine.zombieRelinquish` (dev-gated). + `zombieRelinquishCfg()` gate, debounce (`_g1RelinquishStreak`, confirm=3), reentrancy guard (`_g1Evaluating`), ConfigDefaults block, dark-gate golden-map +7.

**Decision point?** YES — relinquish authority. The dryRun safety invariant + the bootId-consistency fix are load-bearing.

## 1. Over-block
N/A (it relinquishes, never blocks). Biases against relinquishing: not-a-holder → skip; relevant signal fresh → healthy; stale → debounced 3 ticks; only a confirmed zombie relinquishes.

## 2. Under-block
Ships dark+dryRun → no actuation until a deliberate `dryRun:false`. **Enforce-ENABLE prerequisites (TRACKED):** (1) the `lastFetched>lastServed` `pending` counters (currently `pending=false` → keys on pollSucceeded; serveProgressedFresh is computed but inert until pending is wired); (2) positive-peer `globalOutageEvidence` (currently false → local-failure-safe direction); (3) the boot-id-null writer/reader fallback asymmetry (writer falls back to `boot-${pid}`, reader SKIPS on null — reconcile before flipping `pending` live; raised by the 2nd-pass). All inert under dryRun.

## 3. Level-of-abstraction fit
The authority (relinquishAndBroadcast) lives in the leaseCoordinator; the evaluator only decides + calls it. Mirrors `evaluateNobodyPolling`. Reads watermarks via the merged `serveProgress`/`pollIntent` modules.

## 4. Signal vs authority compliance
COMPLIANT: the only authority (relinquish) fires ONLY when `decision.relinquish && !dryRun`, double-gated (enabled + dryRun). The decision keys on machine-local-about-itself signals (Sec-F1) — never a peer value drives a relinquish.

## 5. Interactions
- **bootId consistency (the key correctness fix):** serve-progress is WRITTEN with `getCurrentBootId()` (routes.ts dispatch seam) and READ with `getCurrentBootId()` here — NOT `this.bootId` (a distinct `${pid}-${hrtime}`). Using `this.bootId` would always mismatch the boot-epoch fence → serve never fresh → false zombie. Confirmed correct by the 2nd-pass. `performance.now()` is the shared same-process clock for the freshness subtraction.
- vs tickLease: runs AFTER renew+reconcile in the holder branch; relinquish (when enabled) hands off → next tick the machine is a non-holder → skip. Debounce + reentrancy guard prevent flap/overlap.

## 6. External surfaces
New config `multiMachine.zombieRelinquish` (dev-gated). When `dryRun:false` it WRITES the lease (relinquish) — the reason it ships dark + 2nd-pass-gated. Records to `sharedG1ZombieRelinquishLedger`.

## 7. Multi-machine posture (Cross-Machine Coherence)
The deepest cross-machine fix: binds lease-holding to actually-serving. Machine-local watermarks (skew-immune); the relinquish lets G2's fenced single-claimant pick the successor. Single-machine = no leaseCoordinator → strict no-op.

## 8. Rollback cost
Trivial — ships dark+dryRun (strict no-op). Revert or leave the flag off. No migration.

## Second-Pass Review (REQUIRED — high-risk: lease-relinquish authority)
Independent reviewer: **CONCUR.** (a) dryRun safety GUARANTEED — relinquish reachable only under `!cfg.dryRun`, double-gated by `enabled` (dev-gate, false on fleet); shipped `dryRun ?? true`. (b) The bootId fix is CORRECT — reader uses `getCurrentBootId()` (same source as the writer), not `this.bootId`; `performance.now()` same clock domain. (c)/(d) False-relinquish safe — `pending=false` keys on pollSucceeded (serveProgressedFresh inert until enforce-enable); debounce + isActiveLeaseRole + null-bootId skip + no-poll-active→wedged-only-after-confirm; global-outage=false is the safe direction. (e) reentrancy guard + `.catch` + try/finally → can't wedge/double-fire. **One non-blocking note** (enforce-ENABLE prerequisite, NOT a merge blocker given dark+dryRun): the boot-id-null writer-fallback vs reader-skip asymmetry — reconcile before flipping `pending` live. Recorded in §2 above.
