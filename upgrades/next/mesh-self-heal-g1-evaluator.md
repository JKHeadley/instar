## What Changed

Mesh Self-Heal **G1 zombie-relinquish evaluator** (the FINAL G1 piece, MESH-SELF-HEAL-SPEC §3.1). Wires `decideZombieRelinquish` into `MultiMachineCoordinator.tickLease()`'s holder branch via `evaluateZombieRelinquish()`: each tick, a lease-HOLDER reads its three machine-local liveness watermarks (poll-attempted / poll-succeeded / serve-progressed), debounces the relevant staleness (3 ticks), and — on a confirmed zombie — relinquishes the badge so a healthy machine takes over (via G2's single-claimant). This completes the lease↔job binding: holding the badge now requires actually doing the job.

Ships **dark + dryRun-first** (`multiMachine.zombieRelinquish`, dev-gated): gate-off is a strict no-op; dryRun records "would relinquish" and performs NO actuation. Two independent gates (`enabled` + `dryRun`) protect the relinquish. A key correctness fix: the serve-progress watermark is read with the SAME boot id the dispatch seam wrote with (`getCurrentBootId()`), so the boot-epoch fence matches. Flipping `dryRun:false` (the enforce promotion) is gated on tracked refinements (the pending counters, peer global-outage evidence, the boot-id-null fallback reconciliation) + a live-verify on the real pair.

## Evidence

- Builds on the merged pure `decideZombieRelinquish` (11 unit tests) + `serveProgress` (6 unit tests) + the dispatch-seam write. Dark-gate lint golden map updated (+7); no-silent-fallbacks ratchet at baseline; typecheck clean; G1 unit suite green.
- Independent Phase-5 second-pass review: **CONCUR** (dryRun safety guaranteed; the bootId-consistency fix correct; false-relinquish safe; no tick-wedge). One non-blocking enforce-enable note recorded.

## What to Tell Your User

When this is turned on (it ships off, observe-only for now), it fixes the root cause behind the message-drop incidents: a machine that holds the "in charge" badge but has quietly stopped fetching/serving your messages will automatically hand the badge off — instead of sitting on it while messages drop — and a healthy machine takes over. No action needed; single-machine setups are unaffected.

## Summary of New Capabilities

- `multiMachine.zombieRelinquish` `{ dryRun }` — opt-in (dev-gated) zombie self-relinquish: a lease-holder that has stopped serving gives up the badge. Dark + dryRun by default (observe-only; zero actuation until a deliberate enforce promotion).
