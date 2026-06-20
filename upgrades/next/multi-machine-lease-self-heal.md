## What Changed

The multi-machine "who's awake?" election (the fenced lease coordinator) is now **self-healing**, fixing a live failure class where the mesh could get stuck with NO awake machine and never recover on its own.

- **F1 — lease-tick self-heal (ENABLED by default, safe-by-construction).** Every network call in the lease tick is now bounded by a timeout (`withTickTimeout`), so a single never-settling call can no longer wedge the election loop (the proven 2026-06-19 freeze: a hung call left a reentrancy guard stuck `true`, silencing the tick for 91 minutes while `/health` stayed 200). A monotonic-clocked watchdog re-arms a stalled tick and resets a stuck guard — ceiling-gated so it never preempts a legitimately-slow live tick, never touches authority/epoch state, can't crash the process, and self-disarms (raising one degradation signal) if it fires too often. A true event-loop stall is explicitly delegated to the existing out-of-process fleet watchdog.
- **F2 — stale-holder takeover (⚗️ EXPERIMENTAL, dark by default).** When enabled, a standby may take over the lease from a holder that has silently stopped renewing — detected on the standby's OWN monotonic clock (the holder's signed nonce watermark stalls), so clock drift between machines can never cause a wrongful takeover. CAS-fenced; off ⇒ byte-for-byte the legacy behavior.
- **F3 — silent-standby relinquish (⚗️ EXPERIMENTAL, dark by default).** When enabled, a machine muted to silent-standby that still holds the lease relinquishes it and broadcasts a cryptographically SIGNED tombstone, so peers stop deferring to a zombie holder.
- **F4 — preferred-awake (preview, opt-in; `null` = off).** Name a stationary machine as preferred and a traveling machine defers to it while it's healthy, failing over only when it's genuinely down. Implemented as a deferential standby (the non-preferred machine simply abstains while the preferred is a healthy holder), so a divergent config degrades to the existing baseline rather than flapping.

Observability: `GET /health → multiMachine.syncStatus` gains `leaseTickWatchdog` (`lastTickAgeMs`, `reArmCount`, `disarmed`) and `preferredAwakeMachineId`. Config lives under `multiMachine.leaseSelfHeal`.

## What to Tell Your User

If you run one agent across more than one machine, the part that decides which machine is "in charge" can no longer get permanently stuck — it now times out hung operations and restarts itself. This is on automatically and is a no-op on single-machine setups. Three further robustness behaviors (faster takeover of a dead machine, cleaner hand-off of the "in-charge" badge, and naming a preferred machine) ship turned OFF and are opt-in per machine after verification on a real two-machine setup.

## Summary of New Capabilities

- Self-healing multi-machine awake-election (bounded timeouts + monotonic watchdog) — ON by default, single-machine no-op.
- `multiMachine.leaseSelfHeal` config: `tickWatchdog` (on), `staleHolderTakeover` (dark), `silentStandbyRelinquish` (dark), `preferredAwakeMachineId` (opt-in), `churnDetector`.
- `/health` lease-watchdog + preferred-awake visibility.

## Evidence

- ~50 new unit tests green: `tests/unit/FencedLease.test.ts` (signed-tombstone tamper-fail, canonicalize back-compat, F2 gate both-sides + fail-closed), `tests/unit/LeaseCoordinator-selfHeal.test.ts` (F2 takeover, F3 tombstone, F4 health-gate), `tests/unit/MultiMachineCoordinator-tickSelfHeal.test.ts` (F1 bounded-await + watchdog both-sides + self-disarm, F4 deferral).
- Existing lease/coordinator/transport/store suites regression-clean (129 green); dark-gate lint green (24); tsc clean.
- Spec: `docs/specs/multi-machine-lease-self-heal.md` (3-round spec-converge, approved). Side-effects: `upgrades/side-effects/multi-machine-lease-self-heal.md`.
