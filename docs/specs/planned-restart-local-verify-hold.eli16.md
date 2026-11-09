# Planned restart waits for verification — Plain-English Overview

> The one-line version: when this machine is about to restart itself for routine maintenance, it waits a short, capped time so test runs it has handed to other machines can finish instead of being thrown away.

## The problem in one breath

Before a pull request can merge, its full test suite has to pass. The coordinating machine runs some of these suites itself and hands others to helper machines. When the coordinator restarts for routine reasons, such as installing an update, it comes back as a "new" coordinator and discards every suite it had handed out, even ones nearly finished. In one day this threw away about 78 minutes of helper-machine work across 8 runs. A pull request that loses both of its helper attempts this way falls back to the slower local queue.

## What already exists

- **The local hold** — a planned restart already waits while the coordinator's own test suite is running, for up to three hours. It shipped on 2026-11-02 and has held 5 restarts without losing a run.
- **The override** — an explicit forced restart, or the updater reaching its four-hour ceiling, skips every hold.
- **The pause** — while a planned restart is waiting, the coordinator hands out no new test runs, so the wait cannot keep growing.

## What this adds

The same hold also looks at the test runs the coordinator has handed to helper machines. If a helper has accepted a run, the planned restart waits until that run finishes and its result is collected, but never more than 21 minutes after the run was handed out (in the last week, 412 of 414 helper runs finished inside that), and never past the existing three-hour ceiling.

## The safeguards

**It cannot hold a restart forever.** Each helper run gives at most 21 minutes, no new runs are handed out while a restart waits, and the three-hour ceiling and forced-restart override still apply.

**Only a live, current run causes a wait.** The test service, which is the only part that knows whether a helper run is still alive and belongs to the current coordinator, keeps a short note up to date about every half minute while a helper run is in progress. The restart only waits on a fresh note. If the service is down, the helper stopped answering, or the run belongs to an older coordinator, nothing waits.

**Bad or missing data never causes a wait.** If that note is missing, unreadable or more than 90 seconds old, or a run's start time looks wrong, the restart proceeds exactly as it does today.

**Emergencies are unaffected.** Only routine, planned restarts wait. Crash recovery and emergency restarts go ahead immediately.

**The safety fence stays.** A run handed out before a restart is still discarded if the restart happens anyway. This change only gives the run time to finish first.

## How we will know it worked

We count helper runs discarded right after the coordinator's own restarts, and the minutes they had used, for equal periods before and after the change. The goal is close to zero for restarts that found a run in progress.

## What ships when

One small code change to the existing restart guard, with unit, integration and end-to-end tests, released through the normal pull request path. No settings change and nothing for anyone to do.
