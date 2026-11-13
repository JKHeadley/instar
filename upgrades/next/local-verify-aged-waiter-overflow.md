## What Changed
- **A PR waiting 90 minutes for Local Verify now gets in.** An ordinary PR refused for a full Local Verify queue goes on the waiting list. Only PRs labelled `merge-throughput` could take the 5 overflow places past the cap of 10, so a steady stream of labelled PRs kept the queue full and the waiting list never moved (2026-11-13: PR 3108 waited about 18 h while 10 labelled PRs opened after it were admitted). A waiter first refused at least `THROUGHPUT_AGING_MS` (90 min) ago now shares that overflow, under the same cap. In the queue, `effectivePriority` counts its aging from the first refusal, matching the existing rule that a label can never hold an old PR back.

## What to Tell Your User
Nothing changes for most agents: this only affects the pre-merge test queue that the instar maintainer runs. Pull requests that had been waiting a long time for a test slot now get one within about 90 minutes, even when many priority pull requests keep arriving.

## Summary of New Capabilities
- None. A fairness fix in the Local Verify queue: waiting-list PRs age into the overflow places after 90 minutes.

## Evidence
- `tests/unit/localVerify/waitingListService.test.ts`: a waiter is refused until 90 min, then admitted (audit `agedWaiter: true`); the overflow stays bounded at 15 and an aged waiter past it is still refused. The test fails without the change.
- `tests/unit/localVerify/LocalVerifyService.test.ts`: `effectivePriority` ages from `firstRefusedAt`.
- Live state before the fix: `/local-verify` showed 11 queued (10 labelled), 27 waiting; PR 3108 first refused 2026-11-12 22:30 UTC.
