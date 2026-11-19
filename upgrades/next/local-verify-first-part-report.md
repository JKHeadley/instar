# First-part trials use observations and findings

<!-- bump: patch -->

## What Changed

Local Verify no longer runs a second full comparison after a verify. Each run machine records its verifies and exposes `/local-verify/first-part-report`, including file suspects, confirmed red-main episodes on the coordinator, findings and daily cost measurements. Old comparison state no longer overrides the configured setting.

## What to Tell Your User

Nothing changes for you unless you run your own test line with the "likely failures first" trial switched on. If you do: the trial no longer re-runs changes a second time to check itself, so it no longer takes a test machine out of the line. Each test machine now keeps a daily report of anything that looks lopsided between runs with and without the new order. I read that report, and anything it flags gets a written finding within three days; one that is late is shown as overdue. If the feature makes passing runs slower, or makes runs hit their time limit more often, two days in a row, it switches itself off on that machine and I am told.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Read and evaluate suspects | GET `/local-verify/first-part-report?evaluate=1` |
| Mark the joint trial's start | POST `/local-verify/first-part-report/new-trial` |
| Record an investigation | POST `/local-verify/first-part-finding` with suspect, finding and reason |

All three routes are available on peers. Existing agents receive the rewritten awareness entry automatically on update.
