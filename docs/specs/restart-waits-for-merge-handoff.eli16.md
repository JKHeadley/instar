# A planned restart waits for a merge that is in progress — Plain-English Overview

> The one-line version: when a change has just passed its tests, the server no longer restarts in the few seconds before that change is merged.

## The problem in one breath

Local Verify tests one change at a time and, when a change passes, hands it straight to the merge step. A planned server restart already waits while a test run is going. It did not wait for the merge that follows. On 2026-11-12 a restart fired 15 seconds after PR 3109 passed. The merge step failed because the server was stopping, and after the restart the pass no longer counted, because the restart had loaded a changed test setup. About 40 minutes of testing were thrown away and the change went back in line.

## What already exists

- **The restart guard** — a planned restart is put off while a test run's process is alive, and while a second machine is running a test for us. Every wait has a time limit.
- **The merge line** — a passed change is handed to the merge step at once, and the next test waits until that merge attempt has an answer.
- **The force option** — an operator's forced restart skips every wait.

## What this adds

A planned restart now also waits while a passed change is being merged. It covers two moments: the short gap between the test process ending and the merge being offered (at most one minute), and the merge attempt itself (at most ten minutes).

## The new pieces

- **A small marker file** — written when a run ends and may be merged, updated when the merge is offered, removed when the merge step answers. The restart guard reads it. It only delays a restart; it never blocks one for good.
- **One more entry in the updater's wait list** — the automatic updater sees "PR N passed and its merge is in progress" and waits for it the same way it waits for a running test.

## The safeguards

- Every wait is bounded: one minute for the gap, ten minutes for the merge, and never past the three-hour ceiling a restart request already has.
- A missing, damaged or stale marker means no wait. A marker left by a crash is removed at the next start and expires by itself in any case.
- A forced restart still goes at once.
- Runs that fail, runs of the main branch, and installs with the merge line off behave exactly as before.

## What you need to decide

Nothing. This is a narrow fix that a revert fully undoes.
