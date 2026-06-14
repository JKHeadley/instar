# Side-Effects Review — WS5.2 Increment B / B4: the livetest battery entrypoint (promotion gate)

**Version / slug:** `ws52-incb-b4-livetest-route`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** independent reviewer subagent — CONCUR (a credential-action route that can trigger real swaps → Phase 5 required)

## Summary of the change

Adds `POST /credentials/livetest` (src/server/routes.ts) — the reachable entrypoint for the §5 livetest battery (the Step-10 `CredentialRepointingLivetest` harness). It wires the harness to the REAL swap executor + identity oracle and runs the automatable round-trips (the dry-run→live PROMOTION gate). The destructive surface is protected by TWO independent gates: the harness performs ZERO swaps unless `armed:true` is in the body (the operator explicitly arms the battery), AND even armed, the executor's own `dryRun` keeps writes off until a deliberate `dryRun:false`. Dark → 503 (credLeverGuard); every named slot is validated against the enumerated ledger set (→ 400) before the harness runs. This completes Increment B's tooling — running the battery live is the operator's enablement moment (CMT-1494).

## Decision-point inventory

- `POST /credentials/livetest` — add — a credential-action entrypoint. It can trigger credential swaps, but ONLY when BOTH (a) `armed:true` (harness gate) AND (b) `dryRun:false` (executor gate, set only at construction, never touched by the route) hold. Both gates are independently reviewed (Step 10 harness armed-guard; Step 5 executor dryRun). The route adds only slot-validation + the dark gate.

---

## 1. Over-block
No legitimate input is wrongly rejected: the slot validation rejects only values not in the enumerated ledger set (path-traversal `../`/`~`/absolute can't reach a write — the executor re-validates too). The dark 503 and the not-armed refusal are the conservative directions.

## 2. Under-block
The honest exposure: an operator with the Bearer token who arms the battery AND has flipped `dryRun:false` can move real credentials via this route — which is the INTENT (the promotion gate is the operator's enablement action). The reviewer confirmed no path moves a real credential without BOTH gates; the harness's always-restore leaves no residual exchange even on a forward-verify failure.

## 3. Level-of-abstraction fit
Correct: the route is a thin wrapper that wires the already-reviewed harness to the real executor + oracle. It holds no battery logic of its own (that's the harness) and no swap mechanics (that's the executor).

## 4. Signal vs authority compliance
- [x] Yes — but the authority is the operator's, exercised through two independent explicit gates (armed + dryRun:false). The route grants no autonomous authority; it is a manual, operator-armed entrypoint. (Ref: docs/signal-vs-authority.md.)

## 5. Interactions
- **Double-gate independence:** `armed` (request body) and `dryRun` (executor construction config) are independent; the route passes `armed` through and never overrides `dryRun`. Verified by integration tests (not-armed → refused/zero-swaps; the executor's dry-run path returns 'dry-run' with zero writes).
- **Validation before run:** slot validation + the dark gate run BEFORE harness construction/run.
- No shadowing/race — a manual, synchronous request.

## 6. External surfaces
- A new authenticated route. Dark → 503 (unchanged for a fleet/disabled agent). On a live (dev) agent, NOT armed → a refused report (zero swaps); armed → the battery runs (in dry-run, the round-trips report honestly that identities didn't exchange — real verification needs `dryRun:false`). The report is scrubbed via credSend and carries no token/blob material.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** The battery validates THIS machine's keychain/slots before promoting THIS machine's feature; the route operates on the local ledger + executor + oracle. No cross-machine surface.

## 8. Rollback cost
Trivial. Revert the commit → the route is gone; no state, no migration. Any swap the armed+live battery ever performs is the reversible, oracle-verified, always-restored round-trip the executor + harness own.
