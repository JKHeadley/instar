# Side-Effects Review — Mesh Self-Heal G2 (enforce actuation)

**Change:** The ENFORCE half of G2 (MESH-SELF-HEAL-SPEC §3.2) — actually taking over poll-ownership when nobody is polling. HIGH-RISK: it holds cross-machine poll-ownership authority (the area whose hasty version caused the 2026-06-27 tug-of-war). Pieces:
- `src/core/nobodyPollingActuator.ts` (`applyNobodyPollingRecovery`) — dependency-injected actuator: dryRun gate → `acquireFencedCas` → `decidePostCasSelfReverify` → `startPolling` / `relinquishAndSelfExclude`. 5 unit tests.
- `MultiMachineCoordinator.evaluateNobodyPolling()` — the wiring: gate (`nobodyPollingRecoveryCfg`) → B5 verdict → debounce (`_g2SilenceStreak`, confirm=3) → `decideNobodyPollingClaim` → record → actuate (real ports: `leaseCoordinator.acquireIfEligible` / `currentEpoch` / `writeLeasePollIntent(true)` / `relinquishAndBroadcast`). Reentrancy-guarded (`_g2Evaluating`).
- `server.ts` `refreshPool` — the 30s cadence (fire-and-forget, gated inside the coordinator).
- `ConfigDefaults`: `multiMachine.nobodyPollingRecovery: { dryRun: true }` (OMITS `enabled` → dev-gated). Dark-gate lint golden map updated (+7 line shift).

**Decision point?** YES — it acquires the fenced lease + starts polling. Signal-vs-authority + the dryRun safety invariant are the load-bearing concerns.

## 1. Over-block
N/A (it grants poll-ownership, never blocks). It biases hard against acting: only a confirmed real silence where this machine is the deterministic single claimant AND wins the fenced CAS AND re-verifies its own poll-freshness ever serves.

## 2. Under-block
Ships dark+dryRun (default), so nothing actuates until a deliberate `dryRun:false`. **Enforce-ENABLE prerequisites (TRACKED, not orphan-deferred — see MESH-SELF-HEAL-G2-BUILD.md + the enforce note below):** (1) the real `pollSucceededMonoMs`/serve-progress watermark for `localPollSucceededFresh` (currently a lifeline-liveness approximation — consulted ONLY when dryRun:false); (2) peer-confirmed `globalOutageEvidence` plumbing (currently hard-coded false → a confirmed silence proceeds to elect, the local-failure-safe direction). Both are inert under dryRun.

## 3. Level-of-abstraction fit
The authority lives in the coordinator (it owns the leaseCoordinator); the server only supplies the cadence + capacities. The actuator isolates the delicate flow behind injected ports (testable without a live coordinator; the dryRun gate is a single chokepoint). Reuses `acquireIfEligible` (the SAME fence `tickLease` uses) — not a parallel acquire path.

## 4. Signal vs authority compliance
COMPLIANT with the safety design: the only authority (acquire CAS + start polling) is exercised through the ports ONLY when `dryRun:false` AND the decision is a genuine self-claim. The election is deterministic + machine-agnostic, but it is NOT the authority — the **fenced CAS is the single-claimant gate** (even if two machines diverge on the election under partition, `acquireIfEligible` admits exactly one; the loser gets `cas-lost` and stands down). `decidePostCasSelfReverify` enforces "CAS-win necessary-not-sufficient."

## 5. Interactions
- vs `tickLease`: a won CAS makes this machine the holder → `tickLease`'s non-holder acquire converges (doesn't fight); a successful claim flips the verdict to `ok` (self-terminating). Debounce + post-CAS reverify damp flap.
- Reentrancy: `_g2Evaluating` prevents a >30s eval overlapping the 30s cadence (which would inflate the silence streak pre-await). Added per the 2nd-pass review.
- Cadence: fire-and-forget with `.catch()` — a slow/failed eval never blocks or fails `refreshPool`.

## 6. External surfaces
No new route (the observe `/mesh-selfheal/g2` from the prior PR reads the same ledger). New config path `multiMachine.nobodyPollingRecovery` (dev-gated). When `dryRun:false` it WRITES the lease (poll-ownership) — the reason this is dark-first + 2nd-pass-gated.

## 7. Multi-machine posture (Cross-Machine Coherence)
This IS the cross-machine recovery actuator. Coherence is the deterministic election + the fenced CAS (one winner, pool-wide). The watermarks it reads are machine-local (skew-immune). Single-machine = strict no-op (no leaseCoordinator/peers → `skipped`).

## 8. Rollback cost
Trivial — ships dark+dryRun (strict no-op until a deliberate enable). Revert the commit, or leave the flag off. No migration, no state. Even enabled-in-dryRun performs zero side effects.

## Second-Pass Review (REQUIRED — high-risk: lease/poll-ownership authority)
An independent reviewer audited the actuator + coordinator method + cadence. **Verdict: CONCUR.** Verified: (a) the dryRun invariant HOLDS — the gate sits strictly before every port call; default `dryRun:true` (`?? true`) + dev-gated dark-on-fleet; test pins zero side-effects; (b) single-claimant is genuinely the fenced CAS, not the election guess — a partition divergence still admits exactly one (loser → `cas-lost`); (c) no tug-of-war — the won CAS converges with `tickLease`, debounce + self-reverify damp flap; (d) fail directions correct, hardcoded `globalOutageEvidence:false` is the documented local-safe direction + inert under dryRun. **One concern raised (minor, non-blocking given dark+dryRun): no reentrancy guard** on `evaluateNobodyPolling` — a >30s eval could overlap the 30s tick and inflate `_g2SilenceStreak`. **RESOLVED in this commit** (added `_g2Evaluating` guard, mirroring `leaseTicking`). The reviewer's two enforce-ENABLE prerequisites (the pollSucceeded watermark; the globalOutageEvidence plumbing) are tracked in MESH-SELF-HEAL-G2-BUILD.md as the gate before `dryRun:false`.
