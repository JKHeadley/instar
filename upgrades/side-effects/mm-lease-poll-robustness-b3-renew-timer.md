# Side-Effects Review — B3 renew timer (multimachine-lease-poll-robustness)

**Change:** Add a dedicated lease-renew timer (`clamp(leaseTtlMs × 0.5, [5s, 60s])`) decoupled from the 120s heartbeat-check timer, so a held lease is renewed (SAME epoch) before it lapses — stopping the epoch-climb (default TTL 60s < tick 120s → re-acquire at epoch+1 every tick, observed live 2026-06-20). Dev-gated (`leaseSelfHeal.resilientRenew`, `enabled` omitted → live-on-dev / dark-on-fleet).

**Files:** `src/core/MultiMachineCoordinator.ts` (timer + gate + cleanup), `src/core/LeaseCoordinator.ts` (`ttlMs` getter), `src/core/types.ts` (`resilientRenew` config), `src/config/ConfigDefaults.ts` (default block, no `enabled`), `src/commands/server.ts` (thread `developmentAgent` into the coordinator), `tests/unit/LeaseCoordinator-resilientRenew.test.ts`.

## Phase 1 — Principle check (signal vs authority)
Does this involve a decision point that gates information flow / blocks actions / constrains agent behavior? **No.** It is a pure-timing change: a timer that calls `renew()` (a same-epoch refresh) on a lease THIS machine already holds. It never acquires, never demotes, never gates a message, never changes a role decision. `holdsLease()`, the monotonic self-fence, and `acquireIfEligible()`'s authority are all untouched. The renew tick early-returns unless `holdsLease()` is already true. So signal-vs-authority does not apply — this is a behavior-neutral timing correction.

## 1. Over-block
N/A — blocks nothing. Worst "over" case: it renews more often than strictly necessary (every TTL/2 ≈ 30s vs the old 120s). That is the intent, and the cost is one signed same-epoch refresh per 30s (trivial mesh/file traffic).

## 2. Under-block
N/A — the change does not gate. The remaining gap it does NOT close: a lease that lapses for a reason OTHER than the slow tick (e.g. a genuine partition where renew can't confirm) still self-suspends correctly (unchanged). Decision 3's confirmed-same-epoch-renew-on-lapse (the residual edge where a lapse still happens) is a tracked continuation of this spec <!-- tracked: CMT-1710 --> — it is additive safety, not required for the renew timer to fully fix the normal-case climb.

## 3. Level-of-abstraction fit
Right layer. The renew cadence belongs in the coordinator that owns the lease lifecycle timers (it already owns the heartbeat-check, lease-pull, and tick-watchdog timers). The `ttlMs` getter on `LeaseCoordinator` is the minimal exposure needed to size the timer from the authoritative TTL. No higher/lower layer is a better owner.

## 4. Signal vs authority compliance
Compliant — it adds NO blocking authority and NO brittle decision logic. It is a timer that calls an existing same-epoch renew. (Ref: `docs/signal-vs-authority.md`.)

## 5. Interactions
- **tickLease (120s heartbeat):** unchanged. It still renews-if-holds / acquires-if-not. With the renew timer keeping the lease fresh, tickLease's `holdsLease()` branch now reliably takes the renew path (same epoch) instead of falling to acquire — which is the fix. No double-renew harm: a redundant same-epoch refresh is idempotent.
- **Re-entrancy:** `leaseRenewing` guard prevents overlapping ticks; `withTickTimeout` bounds a hung broadcast so the timer can't wedge.
- **soloCaptainHold / staleHolderTakeover / preferredAwakeMachineId:** untouched — those gate ACQUISITION/role, not renewal cadence.
- **Tick watchdog (F1):** unaffected — the renew timer is a separate `setInterval`; it doesn't touch `lastTickRunMonoMs`.
- Does NOT race with cleanup: `stop()` clears `leaseRenewTimer`.

## 6. External surfaces
One new log line (`[MultiMachine] lease renew timer armed …`), once per boot when enabled. No new route, no user-facing surface, no message. The reduced epoch-advance rate is visible only in `logs/server.log` (fewer `acquired lease at epoch N` lines) — a strict improvement.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** The renew timer is each machine renewing ITS OWN held lease on its own clock. Nothing is replicated or proxied — a standby (non-holder) renew tick early-returns (`!holdsLease()`), so only the actual holder renews. Single-machine no-op: a single-machine / no-leaseCoordinator agent never attaches a coordinator with a lease, so `startLeaseRenewTimer()` returns immediately. Dev-gated, so dark on the fleet until graduated.

## 8. Rollback cost
Trivial. Flip `leaseSelfHeal.resilientRenew.enabled: false` (read live — applies on the next renew tick / restart) → the timer no-ops and behavior reverts to exactly today's (epoch climbs, harmlessly, with the role stable as Phase-0 already ensures). No data migration, no state repair. The change is purely additive (a new timer); removing it cannot corrupt lease state.

## Verification
- `npx tsc --noEmit` clean on the changed files.
- `tests/unit/LeaseCoordinator-resilientRenew.test.ts` — 2/2 pass: (a) renewing every TTL/2 over 50 cycles keeps the SAME epoch (no climb); (b) contrast — letting the lease lapse re-acquires at epoch+1 (the bug, RED-proving the fix's necessity).

## Phase 5 — Second-pass review (high-risk: lease)
An independent reviewer audited the diff + artifact. Verdict: **Concern raised** — the renew tick lacked the `isLeaseObserveOnly` guard that `tickLease`'s observe-only branch enforces, so a machine that booted observe-only/muted while still NAMED in a persisted prior lease (the F3 silent-standby zombie) could have that lease renewed/re-broadcast for up to ~TTL, fighting the silent-standby-relinquish self-heal. **Resolved:** added `if (this.isLeaseObserveOnly) return;` at the top of `leaseRenewTick` (parity with `tickLease`). Reviewer concurred on everything else (fence integrity untouched, dev-gate correct + threaded, lifecycle/cleanup clean, single-machine no-op genuine, test non-vacuous). Re-verified post-fix: tsc clean, 2/2 tests pass.
