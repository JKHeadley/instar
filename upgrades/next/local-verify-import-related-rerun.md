# Local Verify: a second try for a failed test that only imports changed code

<!-- bump: patch -->

## What Changed

Local Verify re-runs a failed test file once, alone, when a lane's only problem is one to three failed files, and clears the file if it passes. On a pull request it refuses that re-run for any file that imports a file the pull request changed. A pull request that edits widely imported code therefore got no re-runs at all, so one flaky test anywhere failed the whole verify (a security fix failed three verifies in a row this way on 2026-11-18).

A new switch, `monitoring.localVerify.importRelatedRerun`, off by default, allows one narrow exception. With it on, such a file is re-run alone three times and cleared only if all three pass, and only when every test that failed in it has already failed and then passed alone, by the same full name, on a green main verify this machine ran itself in the last 7 days. A test that is not on that list, a file the pull request edited, a file-level error, a failed name that occurs twice in the file, or a file whose sequence of test names differs from the one main saw: no second try, as before.

Whatever the switch says, Local Verify now records which named tests failed and passed alone, so the evidence exists when the switch is turned on. Run logs are kept 30 days and then removed; until now they were never removed.

## What to Tell Your User

Nothing changes until this is turned on. If your changes are tested with Local Verify and a pull request that touches widely used code keeps failing on tests it did not break, ask me to turn on the second try for import-related tests. I will then let such a test file run alone three more times, but only when the same test has recently failed and passed by itself on the main branch, which shows the test is unreliable without your change. On the first day it helps little, because that record starts empty; expect the full effect after about a week. Every time it clears a file I record which test, when main showed it unreliable, and both failure lines, and after a week I can run a review that compares how often each cleared test failed on main before and after. You can turn it off again at any time, with no restart.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A second try for a failed test file that imports changed code | Ask the agent to turn it on (config key `monitoring.localVerify.importRelatedRerun`, read live at each run start). On a peer verifier it also needs that machine's own switch. |
| See what was cleared and why | The record's `flakyRetried` entry carries `importRelated: true`, the test names, the three solo run times and, per test, when main showed it flaky and both failure lines. |
| Review the rule after a week | `node scripts/local-verify-import-related-review.mjs` on each machine. It only reads the audit log. |

## Evidence

See tests/unit/localVerify/laneReport.test.ts, tests/unit/localVerify/orchestrator.test.ts, tests/unit/localVerify/record.test.ts, tests/unit/localVerify/peerVerifier.test.ts, tests/unit/localVerify/mainHealth.test.ts, tests/unit/localVerify/importRelatedReview.test.ts, tests/integration/local-verify-routes.test.ts, tests/integration/local-verify-peer-routes.test.ts and tests/e2e/local-verify-lifecycle.test.ts. Spec: docs/specs/local-verify-import-related-rerun.md.
