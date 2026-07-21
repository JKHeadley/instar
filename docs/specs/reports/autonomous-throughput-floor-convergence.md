# Convergence Report — Autonomous Throughput Floor

**Spec:** `docs/specs/autonomous-throughput-floor.md`

**Date:** 2026-07-20
**Binding operator scope:** PULL/AUDIT-ONLY v1

## Re-convergence result

The preserved branch mixed three incompatible designs: action-bearing redispatch code, surface-only
attention prose, and a newer operator instruction forbidding both. Re-convergence selected the narrowest
operator-authorized contract and removed every action seam.

Material findings and resolutions:

1. **A2A redispatch and peer classification exceeded authority.** Removed relay, peer-health,
   preauthorization, budget, effect-ack, and classification dependencies.
2. **Telegram attention/notify exceeded authority.** Removed surface callback and every live/dry-run
   notification state. There is no `dryRun`; runtime is intrinsically read/audit-only.
3. **SelfActionGovernor implied dormant action.** Removed policy and self-action registry entries.
4. **State was one process-wide file.** Replaced with a run-owned, hashed, adjacent 0600 sidecar using
   temp → fsync → rename. Read failure backoff/breaker survives restart.
5. **Deliverable and silence facts had drifted out of implementation.** Restored direct bounded PR
   snapshots and bounded Telegram any-outbound history with coverage checks.
6. **Missing evidence risked false diagnosis.** Invalid scope/history/state, moves, and multi-machine
   posture are `unknown`/`ineligible`; no historical flatline is inferred from missing state.
7. **HOLD semantics were entangled with action.** Preserved the deterministic two-fact invariant while
   making explicit that v1 has no lane authority and therefore cannot grant HOLD.
8. **Future proactive behavior lacked a gate.** Named it only as follow-on work requiring a separately
   converged SelfHealGate. V1 contains no dormant callback or config switch.

## Authority and side effects verdict

Signal-only observation may populate a pull surface and audit log. It may not route, notify, assign,
restart, remediate, or change readiness. The implementation now matches that authority structurally.

## Convergence verdict

**CONVERGED for PULL/AUDIT-ONLY v1.** Open questions: none. The remaining work is implementation
verification and independent code/security review, not design expansion.
