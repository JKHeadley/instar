# Fast focused check before the full PR test run

## What is slow today

A pull request can reach Echo's verifier with a small broken test. Echo already builds the proposed merge and runs lint before the long test suites. It then takes a full-suite slot and runs unit, integration, and end-to-end tests. If a changed unit test would have failed in a minute, the full run may still spend much longer reaching that result. In the measured day, 18 of 47 completed checks were red, but the records do not tell us how many a small early check would have caught. An extra check on every green PR also costs time, so the feature must earn its place by measurement.

## What the change does

After the existing build and lint steps, the verifier may run a small set of tests related to the PR's exact proposed merge. It uses the same test-selection approach already used before a push, with strict limits on the number of changed files, selected tests, and wall-clock time. It runs in the small-test lane before taking the machine's full-suite slot. If selection is too broad or uncertain, the verifier skips this early step and continues normally.

A test that fails once gets one focused retry. If it fails twice in the same selected file, an explicitly enabled mode can return a red result early and let another PR use the full-test slot. This shortcut applies only to PRs Echo's merge watcher can automatically find again after a machine handoff. Echo then schedules one automatic full-suite replay of that exact PR version, at ordinary priority behind already waiting PRs, so an early false alarm has a recovery path. If the replay is green, its full result replaces the early red result. If the early check passes, times out, or cannot be read reliably, the verifier proceeds to all three full suites after confirming the small test processes have exited. The early check can never say that a PR is safe to merge. Only the existing complete, green verification record can do that.

## How we will decide whether to keep it

The feature starts off. An observe mode runs it and records its cost without shortening the full check. We will compare early repeat-red predictions with the actual full results, including any false alarms, separately for each machine. An automatic full replay spends machine time on every early red result, so this design may improve the wait for green PRs but cannot promise fewer total test minutes. We will enable early red results only if queue wait and ready-to-green time improve enough to justify that cost. Turning it off restores the existing path for new attempts. The Studio remains responsible for main-branch checks, and the Mini and M5 remain verifier peers under the same full-suite merge rule.
