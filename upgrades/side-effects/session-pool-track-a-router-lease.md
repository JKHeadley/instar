# Side-Effects Review — Session Pool Track A: Router-Leader Lease (monotonic self-fence)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md (approved, review-convergence stamped)
**Track:** A (L1 — Router-Leader Lease + durable renewal). Ships DARK.
**Files:** src/core/LeaseCoordinator.ts, src/core/MultiMachineCoordinator.ts, src/core/types.ts, src/config/ConfigDefaults.ts

## What changed
1. **`LeaseCoordinator` monotonic self-fence (the core change).** The holder's self-expiry / self-suspend decision — "have I confirmed a renewal within `leaseTtlMs`?" — now measures elapsed on a **monotonic clock** (`monotonicNow()`, default `process.hrtime`) instead of the wall clock (`Date.now()`). A new injectable `monotonicNow` dep; a `markRenewOk()` mutator records the monotonic timestamp at every confirmed acquire/renew/broadcast; `holdsLease()` additionally fences a holder whose monotonic elapsed exceeds the TTL (even before the next `renew()` tick). The wall clock is retained ONLY for the human-readable `expiresAt`/`acquiredAt` display fields and as a conservative second gate in `holdsValidLease`.
2. **`MultiMachineCoordinator.isRouter()`** — a semantic alias of `holdsLease()` so session-pool code can ask "am I the router?" (spec §L1: in v0.1 the router lease IS the fenced leader lease). No behavior change.
3. **`SessionPoolConfig` type + dark config defaults** — `multiMachine.sessionPool: { enabled: false, stage: 'dark', dryRun: true }` added to `SHARED_DEFAULTS`. Migration parity via the centralized `applyDefaults` path (existence-checked).

## Blast radius
- **`LeaseCoordinator`** is on the hot path (`holdsLease()` gates ingress polls, scheduler ticks, outbound sends, registry writes). The added monotonic check is a cheap arithmetic compare on each call. Authority (epoch + push-rejection CAS) is UNCHANGED — only the holder's own self-expiry clock source changed.
- **Wall-clock removal risk:** the wall-clock `lastRenewOkAt` field was removed (it was write-only after the self-suspend moved to monotonic). No other reader existed (verified by grep).
- **Config:** adding `multiMachine.sessionPool` ONLY (never `multiMachine.enabled`) means it is inert — `applyDefaults` merges it under an existing multiMachine block without clobbering, and adds an inert block to agents without multiMachine. No agent's multi-machine state is switched on.

## Risk + mitigation
- **Risk:** a holder that previously relied on a wall-clock-forward jump to self-expire early would now wait the full monotonic TTL. **Mitigation:** the monotonic TTL is the CORRECT bound; the wall-clock `isExpired` second gate still fences early on a forward jump (conservative). Net behavior is strictly safer (immune to backward jumps that previously could SUPPRESS the self-fence — the bug this fixes).
- **Risk:** `process.hrtime` availability. **Mitigation:** present in all supported Node versions; injectable for tests.
- **Regression surface:** existing `LeaseCoordinator.test.ts` self-suspend tests drove the injected wall clock; updated to inject `monotonicNow` tied to the same fake clock. Verified: 155 tests green across the lease/config/coordinator/seamlessness cluster (LeaseCoordinator, FencedLease, ConfigDefaults, multi-machine-coordinator, multimachine-syncstatus, seamlessness-fault-injection, telegram-seamless-contract, seamlessnessConfig, HttpLeaseTransport, coordinator-independent-mode, poll-owner-lease-wiring, PrimaryAggregatorLease).

## Migration parity
- Config default added to `ConfigDefaults.SHARED_DEFAULTS` → auto-applied to existing agents on update via `PostUpdateMigrator.migrateConfig` → `applyDefaults`. Idempotent, existence-checked, never clobbers an operator-tuned value. Test coverage in ConfigDefaults.test.ts (adds-into-existing-multiMachine, no-clobber, inert, idempotent).

## Rollback
- The whole layer is dark (`sessionPool.enabled:false`, `stage:'dark'`). The monotonic self-fence is a pure robustness improvement to the existing lease and is safe to keep regardless; if a revert were ever needed, restore the wall-clock `lastRenewOkAt` self-suspend (single field + the `renew()` comparison). The `monotonicNow` seam is additive (optional dep).

## Agent awareness
- Track A introduces no user-facing surface (internal lease hardening + dark config). The CLAUDE.md Tier-0 blurb + Playbook deep entry land with Track B's `GET /pool` route (the first user-facing surface) and the Machines dashboard tab, per the spec's Migration Parity & Agent Awareness section.
