# Two-machine agents stop fighting over the lease

## What Changed

Fixes the 3 October lease flap, where a paired laptop and Mac Studio took the serving lease from each other every few seconds and Telegram replies were held. Spec: `docs/specs/lease-unconfirmed-candidate-flap.md`.

- **Peer liveness from live evidence** (`src/core/leaseLiveness.ts`, `MachinePoolRegistry`, `LeaseCoordinator`). A peer is judged alive or dead only from this machine's own monotonic pull receipt or a verified signed renewal, never from the registry's `lastSeen`. A peer never observed is not dead and not gone; its lease is taken over at expiry. `acquireIfEligible` folds tunnel renewals in before reading liveness.
- **Lease medium check** (`src/core/leaseMediumSelection.ts`). At boot, `git ls-files` decides whether git can carry `.instar/machines/registry.json`. A git-ignored registry now uses `LocalLeaseStore` plus the authenticated tunnel, with a lease-only `leaseGitRef` for the three lease consumers. `/health` → `multiMachine.syncStatus.leaseMedium` reports `medium`, `reason` and `store`.
- **Internal signals.** These are `DegradationReporter` events in a new internal-only mode that never notifies a user:
  - an unbroken streak of five unconfirmed acquisition writes;
  - a registered peer the liveness feeder has never observed;
  - `failoverThresholdMs <= leaseTtlMs`.
- **Live switches.** `multiMachine.leaseFlapFix.{liveness, mediumCheck, unconfirmedWriteAlert}`, each absent ⇒ on. `mediumCheck` takes effect at restart.
- **Awareness.** A new CLAUDE.md section, with a `PostUpdateMigrator` migration for existing agents.

## What to Tell Your User

If you run me on two machines, they no longer fight over which one is in charge, so replies are no longer held while that settles. This was the problem when a second machine joined on 3 October. Nothing changes if I run on one machine. If I ever need to undo this, the safe order is to stop the second machine and remove it from the pairing first, then switch the fix off.

## Summary of New Capabilities

- A paired machine that has never been heard from is treated as unknown rather than dead, so it is no longer taken over early.
- A git-ignored machine registry uses local lease storage plus the network, matching how single-checkout machines already worked.
- `GET /health` → `multiMachine.syncStatus.leaseMedium` shows which lease storage each machine chose and why.

## Evidence

- Measured, executable harness (`tests/integration/lease-http-convergence.test.ts`): two real `LeaseCoordinator`s with injected clocks, production-shaped timing (lease 20 s, failover 60 s, 200 s runs), and B's store chosen by the real selection function over a real git clone with an ignored registry. The incident reproduced with every switch off: 29 epoch changes, starting at the failover threshold. With the fix there were 0 epoch changes and no time with both holding.
- On every scenario compared against today's behaviour, the fix is not worse. Partition and intermittent-holding windows measure the same as today, as the spec states. Mixed versions with one-way connectivity drop from 120 s with both holding to 0.
- Rolling back `mediumCheck` alone stays stable (0 epoch changes); a full rollback restores the flap (28), which is why the rollback steps say to return to one machine first.
- Unit, integration and E2E suites listed in `upgrades/side-effects/lease-unconfirmed-candidate-flap.md`.
- Independent code review on gpt-6-astra: six findings, all fixed and re-reviewed to APPROVE.
