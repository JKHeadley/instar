# Side-Effects Review — Mesh Self-Heal G1 (core decision logic)

**Change:** The PURE decision core of G1 (lease↔job binding via a three-signal liveness model) from MESH-SELF-HEAL-SPEC §3.1 — `src/core/zombieRelinquish.ts` (`decideZombieRelinquish` + `ZombieRelinquishLedger`) + 11 unit tests. This is increment 1 of G1: the decision only. It is NOT YET WIRED to any tick, watermark plumbing, or actuation — ZERO runtime effect until a later increment consumes it.

**Decision point?** The module encodes a decision (is an active holder a zombie that must relinquish?), but nothing CALLS it yet, so there is no live decision-point in this increment. Signal-vs-authority assessed (Q4).

## 1. Over-block
N/A — unwired. By design it biases AGAINST relinquishing: `not-applicable` for a non-active-holder; `healthy` when the relevant signal is fresh; `await-confirm` until the staleness persists across N ticks. It only relinquishes on a CONFIRMED zombie.

## 2. Under-block
As pure logic, none in-scope. The KNOWN not-yet-built pieces (tracked, not orphan-deferred — see MESH-SELF-HEAL-G2-BUILD.md / spec §3.1): the three-signal watermark plumbing (`pollAttempted/SucceededMonoMs` from `lifeline-poll-active.json`; `serveProgressedMonoMs` in a NEW single-writer `state/serve-progress.json` with a boot-epoch fence), the `lastFetched>lastServed` pending counters, the per-tick debounce, the positive-peer-evidence global-outage signal, and the tickLease holder-branch wiring + F3 `relinquishAndBroadcast` actuation (with the tombstone-nonce quiesce). Until those land, this module is inert.

## 3. Level-of-abstraction fit
Correct. A pure decision module mirroring `nobodyPollingRecovery.ts` (G2) / `leaseGatedSpawn.ts` (G3) — no I/O, fully unit-testable, consumed by a thin wiring layer later. It encodes the spec's exact rule: pending → serveProgressed signal, idle → pollSucceeded signal; wedged poll loop → unconditional relinquish; "can't hear a peer" ≠ global (only positive peer evidence HOLDs).

## 4. Signal vs authority compliance
COMPLIANT. Pure function, no I/O, no authority. The actual authority (`relinquishAndBroadcast` — a signed tombstone) lives in the lease coordinator, which the future wiring calls; this module only DECIDES. The decision keys ONLY on machine-local signals about the machine ITSELF (never a peer-observed value driving a relinquish; finding Sec-F1) — the structural defense against a skew/partition-induced false relinquish.

## 5. Interactions
None in this increment (unwired). Intended (wiring increment): reads the lifeline-actual truth (FD10) + the new serve-progress record; the relinquish runs F3's path; it composes with G2 (a relinquished holder lets G2's single-claimant pick a server) and G3 (the lease it binds is the same fence G3's spawn gate reads).

## 6. External surfaces
None yet. No route, config flag, or watermark write in this increment — pure logic. The exported `sharedG1ZombieRelinquishLedger` singleton mirrors the G2/G3 ledgers; written/read only once the wiring lands.

## 7. Multi-machine posture (Cross-Machine Coherence)
This IS the deepest cross-machine coherence fix — binding "holds the lease" to "actually serving" so a zombie holder self-relinquishes. The three watermarks are machine-local, never replicated (Sca-F1), evaluated by each machine about ITSELF (skew-immune — no foreign-monotonic subtraction). The decision is local; coherence emerges because a zombie relinquishes and G2's fenced single-claimant picks the successor.

## 8. Rollback cost
Trivial — revert the commit. Unreferenced by any runtime path, so removing it cannot affect a running agent. No config, no migration, no state.

## Second-pass review
Not triggered for this increment (unwired pure logic, no live decision-point / block-allow authority / session-lifecycle touch). The Phase-5 second-pass IS required for the WIRING increment (it consumes lease-relinquish authority + adds cross-process watermark plumbing) and is flagged for that increment.
