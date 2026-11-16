<!-- bump: patch -->
## What Changed

Besides testing each change, the coordinator machine tests the main branch itself. That main test waits in the same line as the changes and, while main is healthy, lets changes go first for up to 90 minutes. Until now it then ran on the version of main it had been queued for, which by that time main had usually left. A pass on an out-of-date version does not cover the newer merges, so a second main test was due at once (2026-11-16: twice in one day, about 80 minutes of back-to-back main tests each time while eight changes waited).

- When a queued main test starts and main is healthy, it now runs on main's version as observed at that moment (through the release-commit alias, so a release commit of an already covered version starts nothing new). The log records `main-replaced` with `why: stale-at-start`.
- Unchanged: while main is suspect or red, the queued version (the re-run of a failed version) runs as queued. If main's version cannot be read, the queued version runs.
- The newer version's own delayed enqueue is marked handled, so it is not queued a second time.

## What to Tell Your User

Nothing changes for people who run one machine without the test line. If your agent tests its own changes, the periodic test of the main branch now always covers the newest version in one run, instead of testing an old version and then starting over, so changes waiting to be tested get the machine back sooner.

## Summary of New Capabilities

- No new routes or settings. One scheduling decision corrected.

## Evidence

- Unit: `tests/unit/localVerify/mainHealth.test.ts`, block "a pending main verify starts on the head current at its start (2026-11-16)" (7 cases: moved head; unmoved head; unreadable head; suspect; red; release commit of the queued head; release commit aliased to another covered head) and the updated 2026-11-15 case, 68 passing. `tests/unit/localVerify/LocalVerifyService.test.ts` still green (162).
- Incident: coordinator `local-verify.jsonl`, 2026-11-16: `main-queued` 19:06:37Z for 6252ddba1, main moved at 19:31Z and 19:53Z, that version ran 20:38:46Z to 21:17:58Z, `main-queued` 20:56:23Z for f69ac8d38, which started at 21:18Z. Same shape at 16:21Z / 17:54Z / 17:57Z.
