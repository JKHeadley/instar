# A green test of main counts even when main moved before it finished

<!-- bump: patch -->

## What Changed

Local Verify keeps a clock, `mainObs.oldestUnverifiedAt`: the oldest merge not yet covered by a green `main` verify. Past three hours `main` becomes `main-suspect` (`unverified-too-long`) and only repairs may merge. A green verify moved that clock only when the verified head was still current at the end, or when the run had started on the then-current head (#3170). With a merge or a release commit every 20 to 30 minutes and a 35-minute verify that waits its turn for the slot, neither is usually true. On 2026-11-15 three green `main` verifies ran between 09:51Z and 14:26Z, the clock stayed at the first merge after boot, and `main` was `main-suspect` from 13:38Z; it flipped back 14 seconds after the 14:26Z green. Passed PRs sat at `main-suspect · repair-only`.

The service now remembers, per head, when a different head was first observed after it (`noteHeadSuperseded`, first observation kept, 50 heads). A green verify of head A covers every merge up to A, so the clock moves to the time A was replaced (`supersededAtFor`, which also follows A's release commit when that took its place), through a new fourth argument of `oldestUnverifiedAfterGreen`. It never moves backwards, and a head never seen replaced changes nothing.

One existing behaviour is refined: a green re-run of an older head used to leave the clock untouched; it now moves to the moment that head was replaced (earlier than the re-run's start, so still strict).

No config, state or migration. The replacement times live in memory and are rebuilt after a restart, when the boot verify is of the current head anyway.

## What to Tell Your User

Nothing changes for you. A development safeguard had been closing merging every three hours on busy days even though the main line was being tested and passing; it now counts those tests correctly.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| The unverified-main clock follows green verifies of heads that were replaced before the run ended | Automatic |

## Evidence

- `tests/unit/localVerify/mainHealth.test.ts`: pure cases for `oldestUnverifiedAfterGreen` (replacement time, later-of-two, never backwards, unreadable value), `noteHeadSuperseded` (first time kept through a stale read, bounded) and `supersededAtFor` (own time, release commit, never replaced); service cases: the 2026-11-15 pattern for 7.5 hours stays healthy; a head replaced only by its release commit covers up to the release commit's replacement; the re-run case alarms three hours after the head was replaced.
