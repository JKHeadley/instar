# Side-Effects Review — B2 churn breaker (multimachine-lease-poll-robustness, Decision 8)

**Change:** Implement the consumer for the previously-DEAD `leaseSelfHeal.churnDetector` config — a lease flap circuit-breaker (`ChurnBreaker`). On >`maxFlipsPerWindow` real role transitions within `windowMs`, it LATCHES; the latched role is DETERMINISTIC (preferred-awake machine → awake, others → standby) so the resting state is exactly-one-awake, never a mid-flap coin-flip snapshot. Auto-resets after a calm window; EXHAUSTS (stays latched) above `maxLatchesPerHour` (guard-bypass-carries-its-own-cap). Wired observe-only/**dry-run**: `reconcileRoleToLease` records each true flip and LOGS the would-latch verdict; applying the deterministic role is the live graduation (`dryRun:false`). Dev-gated (`churnDetector.enabled` omitted → developmentAgent gate).

**Files:** `src/core/churnBreaker.ts` (new pure breaker), `src/core/MultiMachineCoordinator.ts` (field + getter + recordFlip in reconcileRoleToLease + tick in tickLease), `src/core/types.ts` + `src/config/ConfigDefaults.ts` (`enabled`/`dryRun`/`maxLatchesPerHour`), `tests/unit/churnBreaker.test.ts`.

## Phase 1 — Principle check (signal vs authority)
It feeds a decision (latch → hold a role), so the principle applies. As shipped here it is **signal-only** (dry-run: records + logs, applies nothing) — the role-application authority is gated behind a deliberate `dryRun:false`. The breaker logic is deterministic (a flip counter over a window + a deterministic latch target from the existing `preferredAwakeMachineId`), not brittle. When it does graduate to live, it stops a machine CONTENDING (the safe direction — it never force-promotes a peer), and the deterministic target guarantees exactly-one-awake.

## 1. Over-block
When live, the risk is latching the WRONG machine. Designed out: the latch target is deterministic (preferred→awake / other→standby), not a snapshot — so two machines latch to consistent, complementary roles (the spec's core B2 fix). In dry-run (this ship) it blocks nothing.

## 2. Under-block
A flap slower than `maxFlipsPerWindow / windowMs` won't trip it — by design (that's not a flap). The window pruning is unit-tested (a slow drip never trips).

## 3. Level-of-abstraction fit
Right layer. `reconcileRoleToLease` is the single chokepoint for real role transitions (it's past the `desired === this._role` early-return), so it's the correct place to count flips. The pure `ChurnBreaker` isolates the lifecycle for testing.

## 4. Signal vs authority compliance
Compliant. As shipped: pure signal (dry-run log). The breaker class holds no authority; the coordinator decides. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
- **reconcileRoleToLease:** the recordFlip is appended AFTER the transition is fully applied + emitted; it cannot alter the transition. A throw is impossible (pure in-memory).
- **tickLease:** a `getChurnBreaker()?.tick()` at the top advances auto-reset; no-op when the gate is off; pure, cannot wedge the tick.
- **preferredAwakeMachineId (Phase-0 / F4):** the breaker REUSES it as the deterministic latch target — consistent with the live stabilization, never fights it.
- **Monotonic clock:** the breaker is driven by `monoNowMs()` so a wall-clock step can't fake/mask a flap.

## 6. External surfaces
One new log line, only when the breaker latches (`[MultiMachine] [churn] breaker LATCHED …`). No route, no message, no Attention item yet (the Attention raise + /guards row are the live-graduation increment). Dry-run by default.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** Each machine runs its own breaker over its OWN role transitions; the deterministic latch target is computed from the (replicated-by-config) `preferredAwakeMachineId`, so two machines independently reach complementary roles WITHOUT coordination — that's the point. Nothing replicated/proxied. Single-machine no-op: a single-machine agent never flips role, so the breaker never trips; the gate is also dark on the fleet.

## 8. Rollback cost
Trivial. `churnDetector.enabled:false` (read live each transition/tick) → the breaker is not built, zero effect. The role-application is additionally behind `dryRun` (default true) so even enabled it only logs until a deliberate flip. No state, no migration.

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/churnBreaker.test.ts` 6/6: no-latch at-or-below threshold; latch above threshold; DETERMINISTIC role (preferred→awake / other→standby); auto-reset after a calm window; EXHAUSTION above maxLatchesPerHour (stays latched, no auto-reset); window pruning (a slow drip never trips).

## Phase 5 — Second-pass review (high-risk: lease role-transition path)
Independent reviewer verdict: **Concur with the review.** Verified: recordFlip counts ONLY true flips (after the `desired === this._role` early-return); the wiring is pure in-memory and cannot throw/wedge the transition path; genuine no-op gate-off AND dry-run (NOTHING reads the verdict to override the role — cannot regress the live Phase-0 stabilization); lifecycle correctness (`>` trip, deterministic latch, calm-window auto-reset, exhaustion stays-latched, window/hour pruning, no unintended never-reset); monotonic clock is the right skew-proof source. Recommendation (added): an explicit two-machine complementary-resting-state test before the `dryRun:false` graduation — **added** (now 7/7 green). Noted for the live increment: getChurnBreaker rebuilds (loses history) on an off→on runtime toggle (harmless/conservative).
