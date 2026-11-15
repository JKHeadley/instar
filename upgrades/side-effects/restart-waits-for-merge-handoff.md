# Side-Effects Review — a planned restart waits for a merge that is in progress

**Version / slug:** `restart-waits-for-merge-handoff`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (narrow bug fix, a revert undoes it). 4 files: `src/core/PlannedRestartVerifyGuard.ts`, `src/localVerify/LocalVerifyService.ts` and their two unit test files. No spec review rounds; one commit attempt expected.

Incident: 2026-11-12 20:24Z, PR 3109. A planned restart deferred behind a running verify went ahead about 15 seconds after the run ended green. The merge hand-off answered `list-failed` while the server stopped, the restart loaded a changed verifier, and the green record was skipped at index rebuild. The run (41 minutes) was lost.

Fix: a bounded restart hold across the merge hand-off. `LocalVerifyService` writes `state/local-verify/merge-hold.json` (`settling` before the in-flight marker is cleared in `onExit`, `handoff` in `offerMerge`), removes it when the hand-off settles or when no hand-off was opened, and removes a leftover one at boot. `plannedRestartVerifyState` treats a fresh marker as a hold (60 s settling, 10 min handoff). `restartHolds()` adds `local-verify:merge-pr-N` for the auto-updater.

## Decision-point inventory

- `plannedRestartVerifyState`: one more reason to defer a planned restart. Only ever a bounded delay.
- `LocalVerifyService.restartHolds`: one more bounded hold entry for the updater.
- `onExit`: the "run ended, restart may go" notification is moved to the end of the hand-off for PR runs that may be merged.

## 1. Over-block

A planned restart can now wait up to 10 minutes longer after a green run, when the watcher's merge attempt is slow (safe-merge waiting on checks). The merge line's own queue hold is 30 minutes; the restart hold is deliberately shorter. A restart that would have rescued a hung watcher call waits at most those 10 minutes. No other input is delayed.

## 2. Under-block

- A record that the watcher refuses at hand-off (for example `needs-independent-review`) is merged later by the watcher's tick. A restart in between is not held, and a restart that changes the verifier still discards the record. That is the existing behavior for every waiting green record and is not changed here.
- An unplanned restart (crash, kill, forced restart) is not covered and cannot be.
- The lifeline supervisor runs the code it started with; it reads the marker only after the lifeline itself reloads onto this version. Until then the in-process updater hold and the foreground watcher cover the path, and the supervisor behaves as before.

## 3. Level-of-abstraction fit

The guard already owns "may a planned restart go now" for Local Verify, with two sources (a live run child, a peer heartbeat). This adds a third source in the same function and the same file convention. No new layer.

## 4. Signal vs authority compliance

The marker is a signal written by the component that knows a merge is in progress. The authority (defer or not) stays with the existing restart guard, and the only power it has is a short delay with a hard bound. A missing, malformed, future-dated, wrong-version or stale marker never defers. An explicit bypass wins. No brittle check holds lasting blocking authority.

## 4b. Judgment-point check

No judgment call is replaced by a rule here; the bound is a backstop on a delay, not a verdict about work.

## 5. Interactions

- Peer hold: the later of the peer bound and the merge bound wins, capped at the request ceiling (tested).
- `runEnded` listener: for a PR run that may be merged it now fires when the hand-off settles instead of at child exit; for red runs, main runs, peer attempts, cancelled runs and installs without the merge line it fires exactly as before (tested).
- A settling write never replaces another PR's open `handoff` marker.
- Queue pumping and the merge line's own hold are untouched.

## 6. External surfaces

One new state file under `state/local-verify/`. One new hold name visible in the updater's deferral reasons (`local-verify:merge-pr-N`). Two new audit events are not added; one failure event `merge-hold-write-failed` is.

## 7. Multi-machine posture

Machine-local by design. The marker describes a merge attempt made by this process on the machine that holds the serving lease; a restart on another machine does not affect it. A peer verifier never merges and never writes the marker (the merge line is not wired there).

## 8. Rollback cost

Revert the commit. A leftover marker file is ignored by old code and harmless.

## Conclusion

Smallest change that closes the observed window (a restart between a green record and its settled hand-off). It narrows, and does not remove, the wider case of a restart discarding a green record that is still unmerged (section 2). Ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given the diff and the incident, not the author's conclusion), 2026-11-12
**Independent read of the artifact: concur**

The reviewer read `onExit`, `complete`, `offerMerge`, `restartHolds`, `shutdown`, `rebuildIndex` and the three consumers, and ran both changed test files singly (23/23 and 146/146). No blocking defect. Findings, all non-blocking:

1. The incident window is closed for all three consumers; peer-imported records are covered because `offerMerge` writes the `handoff` marker; excluding `main` runs is correct.
2. The lifeline supervisor reads the marker only after the lifeline itself restarts (stated in section 2).
3. Residual windows remain by design: a refused hand-off, a hand-off skipped as `hold-active`, and an attempt running past 10 minutes. The description now says "narrows".
4. A failed marker write suppressed the "run ended" notification. FIXED in this change: the notification now fires at exit when the settling marker could not be written, with a test.
5. Every hold is bounded and an explicit bypass still wins.
6. No regression found; cosmetic: `auditPeerHolds` can attribute a merge-caused hold to a peer attempt.
7. Test gaps named: write order not directly asserted; no supervisor or foreground-watcher tick with a merge marker; no peer-imported case; no other-PR-holds-the-line case. Added after the review: boot clears a stale marker; a marker that cannot be written.
8. Signal versus authority acceptable: the file can only defer, fails open, has a hard bound per phase.

## Evidence pointers

- `.instar/logs/local-verify.jsonl` on the Studio, 2026-11-12T20:24:42Z to 20:25:40Z (record, merge-handoff, merge-handoff-result list-failed, index-rebuilt skippedVersion 501, status-posted pending).
- `tests/unit/planned-restart-verify-guard.test.ts`, describe "a green run whose merge is in progress".
- `tests/unit/localVerify/LocalVerifyService.test.ts`, "a planned restart waits for the merge" and "a red run, a refused hand-off and a detached watcher leave no merge hold behind".

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in the restart path; the new tests are the regression guard).
