# A planned restart waits for a merge that is in progress

<!-- bump: patch -->

## What Changed

Local Verify hands a green PR record to the merge watcher the moment the run ends. A planned restart was held only while the run's child process was alive, so it could fire between "record written" and "merge attempt settled". On 2026-11-12 that happened to PR 3109: the hand-off answered `list-failed` while the server stopped, the restart loaded a changed verifier, and the green record was skipped at the next index rebuild.

`LocalVerifyService` now writes `state/local-verify/merge-hold.json` (`settling` before the in-flight marker is cleared, `handoff` when the merge is offered) and removes it when the hand-off settles. `plannedRestartVerifyState` (read by the lifeline supervisor and the foreground restart watcher) holds a planned restart while that marker is fresh: 60 seconds for `settling`, 10 minutes for `handoff`, never past the request's three-hour ceiling. `restartHolds()` gives the auto-updater the matching in-process hold `local-verify:merge-pr-N`. An explicit bypass still skips every hold. A marker left by a previous process is removed at boot.

## What to Tell Your User

Nothing changes for users. On machines that test and merge instar's own changes, a planned restart now waits a short, limited time when a change has just passed its tests and is being merged, so the pass is not lost.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| A planned restart waits (at most 10 minutes) for a green verify's merge attempt | Automatic where Local Verify's merge line is on; a forced restart still goes at once |

## Evidence

Audit lines from the Studio, 2026-11-12: `record` success for PR 3109 at 20:24:42.235Z, `merge-handoff` at 20:24:42.236Z, `merge-handoff-result` `list-failed` at 20:24:43.770Z, `index-rebuilt` with `loaded: 0, skippedVersion: 501` at 20:24:57.537Z, then `status-posted` `pending / awaiting-verify` for the same head at 20:25:40Z.

Tests: `tests/unit/planned-restart-verify-guard.test.ts` (five new cases for the marker: both bounds, malformed markers, bypass, ceiling, interaction with a peer hold) and `tests/unit/localVerify/LocalVerifyService.test.ts` (the marker exists before the run marker goes and ends with the hand-off; red runs, refused hand-offs and a detached watcher leave nothing behind). 169 tests pass across both files.
