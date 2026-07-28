---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13481; multi-machine live-transfer cascade)
---

# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — a silent standby machine now correctly recognizes the awake machine as in charge

Two narrow fixes for the multi-machine live session-transfer path (the one that
moves a conversation from one machine to another when you say "move this to the
Mac mini"). Both were found by running the transfer live between a laptop and a
Mac mini and tracing why the handoff was rejected.

1. **Signing-key fallback.** Each machine signs its mesh messages with a private
   key file. The loader looked only for the current filename; a machine whose key
   was saved under the older filename threw an error at boot, which silently
   aborted its lease-coordination setup — so it never learned which machine was in
   charge. The loader now also checks the legacy filename before giving up,
   matching the fallback the lifeline loader already had.

2. **Silent standby stops crowning itself.** A machine configured as a silent
   standby (it never answers messages on its own) was still trying to claim the
   "I'm in charge" lease at startup. On a machine without the shared git-backed
   coordination medium, that produced a split-brain where both machines thought
   they were in charge and the handoff was refused. A silent standby now only
   watches the lease and never claims one, so the awake machine always wins and the
   handoff is accepted.

## Summary of New Capabilities

- `MachineIdentity.loadSigningKey()` falls back to the legacy `signing-private.pem`
  when the canonical `signing-key.pem` is absent (rethrows if neither exists).
- `MultiMachineCoordinator.isLeaseObserveOnly` (driven by
  `multiMachine.telegramPolling === false`): a silent standby skips lease
  acquire/renew in both `initializeLease` and `tickLease`, only reconciling its
  role to the observed lease — removing the git-less split-brain epoch leapfrog.

## What to Tell Your User

If you run your agent on more than one machine, moving a live conversation from one
machine to another is now more reliable. A quiet backup machine will correctly
treat your main machine as the one in charge instead of fighting it for control,
and a machine whose security key was saved under an older filename will no longer
fail to join the handoff. Nothing to configure — it applies on the next update.

## Evidence

- Both bugs were found live on the two-machine setup (laptop plus Mac mini) by
  instrumenting the lease broadcast or observe path: the mini threw ENOENT on the
  canonical key at boot so its lease coordinator never attached, and once that was
  fixed it rejected the laptop's lease as below its own self-issued epoch floor.
- Unit, `tests/unit/machine-identity.test.ts`: loadSigningKey falls back to the
  legacy name and still throws when neither file exists.
- Unit, `tests/unit/multi-machine-coordinator.test.ts`: a silent standby never
  acquires or renews (across initializeLease and tickLease); a normal machine does
  acquire; the observe-only flag reflects telegramPolling false.
- 109 related unit tests pass (machine-identity, multi-machine-coordinator,
  LeaseCoordinator, mesh-signing-key-resolution, multimachine-syncstatus);
  tsc --noEmit clean.
- Spec, `docs/specs/silent-standby-lease.md` plus the .eli16.md sibling.
- Side-effects, `upgrades/side-effects/silent-standby-lease.md`.
