# Side-Effects Review — B1 poll-intent file + server producer (multimachine-lease-poll-robustness, Decisions 5/6)

**Change:** Add the cross-process poll-intent file module (`pollIntent.ts` — atomic write/read + a pure freshness/integrity gate `effectivePollIntent`) and wire the SERVER producer: `MultiMachineCoordinator` writes its lease-derived poll intent (`{shouldPoll, leaseEpoch, role, serverPid, bootId, ts}`) in `reconcileRoleToLease` (on every real role transition) and a safe default (`shouldPoll:false`) at lease boot. **Observe-only / producer-only: NOTHING reads the intent yet** (the lifeline `reconcilePolling` consumer is the next increment), so this cannot change Telegram ingress or role. Dev-gated (`multiMachine.pollFollowsLease`, `enabled` omitted → developmentAgent gate).

**Files:** `src/core/pollIntent.ts` (new), `src/core/MultiMachineCoordinator.ts` (bootId + resolver + writer + 2 call sites), `tests/unit/pollIntent.test.ts`.

## Phase 1 — Principle check (signal vs authority)
Pure producer of an advisory file + a pure trust gate. No authority — it writes a file no code reads in this commit. The freshness gate (`effectivePollIntent`) returns `null` (= "no opinion" = the lifeline will HOLD) on any uncertainty (stale/dead-writer/corrupt), the safe direction.

## 1./2. Over/Under-block
Gates nothing. Integrity (unit-tested): a stale `shouldPoll:true` (old ts, or dead writer pid) → null, so it can NOT resurrect a poller after a crash; a stale `shouldPoll:false` likewise → null, so it can NOT wrongly silence a live machine; corrupt/partial JSON → null (never trusted). Boot writes the safe default (mute).

## 3. Level-of-abstraction fit
Right layer — `reconcileRoleToLease` is the single role-transition chokepoint (the correct producer point); `pollIntent.ts` isolates the file protocol + the pure trust gate.

## 4. Signal vs authority compliance
Compliant — advisory file, pure gate, no blocking authority. (Ref `docs/signal-vs-authority.md`.)

## 5. Interactions
- **reconcileRoleToLease:** the write is appended AFTER the transition + the existing log, alongside the (observe-only) B2 breaker call. Guarded by try/catch → a write failure logs once, never throws into the role-transition path. Cannot alter the transition.
- **No consumer:** grep confirms nothing reads `telegram-poll-intent.json` in this commit; the lifeline consumer + the Phase-0 pin migration land next behind the same flag.

## 6. External surfaces
A new file `state/telegram-poll-intent.json` (local same-uid IPC, never network-reachable; parity with `TelegramPollOwnerLease`). One log line only on a write failure. No route, no message.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN** — each machine's own server writes its own intent for its own lifeline; nothing replicated/proxied. Single-machine / gate-off: `pollFollowsLeaseEnabled()` false or no leaseCoordinator → the writer is a no-op.

## 8. Rollback cost
Trivial — `pollFollowsLease.enabled:false` (read live) → no writes. The file is advisory; deleting it = no opinion. No state/migration.

## Verification
- `npx tsc --noEmit` clean.
- `tests/unit/pollIntent.test.ts` 8/8: atomic write/read round-trip; missing → null; corrupt/partial → null; fresh+live → shouldPoll; stale-ts → null; dead-pid → null; fresh mute honored.

## Phase 5 — Second-pass review (touches the lease role-transition path)
Independent reviewer verdict: **Concur with the review.** Verified genuinely observe-only (grep confirms NO production consumer of the intent — only the writer + tests, so it cannot change ingress/role), the write is try/caught + atomic (cannot throw into the role transition), the gate is correct (dev-gate; no-op single-machine/off), the integrity logic never trusts a stale shouldPoll:true (stale-ts/dead-pid/corrupt → null), and the boot default-mute overwrites a prior-boot stale record. One doc-accuracy nit (the comment claimed a graceful-shutdown mute that this diff doesn't implement, non-load-bearing since the consumer's dead-pid gate covers it) — **corrected** the comment. Everything that ships fails safe.
