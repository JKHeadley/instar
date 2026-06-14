# Side-Effects Review — WS5.2 Increment B / B3b-wire: balancer wired into the server (dry-run on dev)

**Version / slug:** `ws52-incb-b3b-wire`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** independent reviewer subagent — CONCUR (wires autonomous-write actuation into the live server → Phase 5 required)

## Summary of the change

Wires the (already-reviewed) `CredentialRebalancer` orchestrator into the server composition root: constructs it in the `credentialRepointing` bundle (server.ts) with the snapshot-mapper providers + the re-gated `isEnabled`, schedules a reentrancy-guarded periodic `setInterval` pass, adds `rebalancer` to the bundle, and extends `GET /credentials/rebalancer` to report `rebalancer.status()` (last pass + breaker) alongside the env-token gate verdict. Because the feature is re-gated to live-on-dev-in-dry-run, on a DEV agent this loop now RUNS every ~5min in dry-run (full decision loop + audit, ZERO credential writes); on the fleet it is a strict no-op. This is the dogfooding the maturation path needs (CMT-1493). Real writes still require a deliberate `dryRun:false` (CMT-1494).

## Decision-point inventory

- `credentialRebalancer.tick()` (now scheduled) — the autonomous balancer pass, now LIVE-on-dev in dry-run. Its `isEnabled` mirrors the location gate exactly (dev-gate-resolved AND not env-token-refused); the destructive write is gated by the executor's own `dryRun` (default true). The orchestrator's decision/breaker logic was reviewed in B3a; this change is the WIRING.

---

## 1. Over-block
No block/allow surface. Conservative direction preserved: the pass is a strict no-op whenever the feature is dark OR the env-token gate refuses; even when it runs (dev), the executor's dry-run gate blocks every write.

## 2. Under-block
The new exposure on a dev agent: the balancer loop now actuates decisions (in dry-run) every pass. The reviewer confirmed no path writes a credential without an explicit `dryRun:false`. The known operator-opt-in subtlety (an explicit `enabled:true` resolves the gate true even on a fleet agent) is the documented two-flag design and remains write-protected by the dry-run default.

## 3. Level-of-abstraction fit
Correct: the wiring layer holds ONLY the construction + scheduling; the decision is the pure policy's, the actuation is the gated executor's, the cross-pass state is the orchestrator's. The snapshot mappers (kept pure) translate live state. The setInterval is the thin "make it run" layer.

## 4. Signal vs authority compliance
- [x] Yes — the conservatively-bounded actuation authority the §2.4 Tier-0 justification sanctions: deterministic policy, oracle-verified reversible swaps, every pass audited, dark + dry-run-first. The wiring grants no NEW authority beyond scheduling the already-reviewed orchestrator under the unchanged gate. (Ref: docs/signal-vs-authority.md; §2.4.)

## 5. Interactions
- **Gate interaction:** `isEnabled` is byte-identical to the location gate, so the balancer and the QuotaPoller-attribution path agree on dark/live. The executor's own dark/dryRun gate is belt-and-suspenders.
- **Timer:** reentrancy-guarded (a slow tick never overlaps), interval clamped [60s, 60min], `.unref()`'d (never holds the process open), tick errors caught (a throw never crashes the loop or sticks the in-flight flag).
- **Route:** the dark path (`!credRepointEnabled()`) short-circuits to a 503 no-op BEFORE touching the rebalancer; the enabled path adds `balancerWired` + a leak-free `status()` (only enabled/breaker/cooldown counts + the last pass's slot/account/objective/reason — no token/blob material; scrubbed via `credSend → audit.response`).

## 6. External surfaces
- On a **dev agent**: `GET /credentials/rebalancer` now reports `balancerWired:true` + the live status, and the balancer runs its dry-run loop (visible in the audit + DegradationReporter/attention on a surfaced terminal state). Zero credential writes. On the **fleet**: byte-for-byte unchanged (dark 503; the unref'd timer's tick is a strict no-op).

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** Each machine schedules its own pass over its own ledger/pool/keychain snapshot; the in-memory cooldown/breaker state is per-process. No cross-machine input or coordination.

## 8. Rollback cost
Low. Revert the commit → the rebalancer is no longer constructed/scheduled and the route returns to `balancerWired:false`. No state, no migration, no credential touch (dry-run never wrote). Any swap the live balancer ever performs is the reversible, oracle-verified, dry-run-gated round-trip the executor owns.

## Follow-ups (tracked, not orphaned)
- An explicit operator default-account config + tmux-activity busyness for the drain target are dogfood refinements `<!-- tracked: 20905 -->` (B3b uses the current `~/.claude` tenant as the desired default and uniform busyness for now — safe in dry-run).
- B4 (livetest tie-in) + the `dryRun:false` promotion decision are tracked as commitments CMT-1493 / CMT-1494.
