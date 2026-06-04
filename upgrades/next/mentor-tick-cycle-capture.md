<!-- bump: patch -->

## What Changed

The automated mentor-onboarding tick now records a keystone
`mentor-mentee-differential` apprenticeship **cycle** each run (in addition to the
existing per-finding ledger capture) — the structural version of the manual
differential-oversight loop. The mentee's Stage-A transcript becomes the cycle's
`menteeOutput`; the forensics findings become the `overseerDifferential`.

It is wired via a new optional `recordCycle` injected into `runMentorTick` and
`MentorOnboardingRunner`, and a new `mentor.apprenticeshipInstanceId` config field.
`AgentServer.buildMentorRunner` resolves it to the ApprenticeshipCycleStore only
when that instance id is set — so it is **opt-in and a no-op by default**
(back-compat). This makes the automated loop fire the keystone axis the program's
role-coverage drift-warning watches, instead of only the easy finding-capture path.

## What to Tell Your User

Nothing changes by default. When I'm running an automated mentorship for a
configured apprenticeship instance, the loop now records proper differential cycles
on its own — the same keystone cycles I capture by hand — so the program can see
the real mentor↔mentee work, not just logged findings.
