# Job launch e2e: the mock CLI answers its version in 0.2 s, not 1 s

## What Changed

Test-only. `tests/e2e/job-launch-lifecycle.test.ts` launches a mock `claude` whose `--version` answer was delayed by 1 second. The product's version probe is killed after 2 seconds and then, by design, leaves `launch.cliVersion` as `unknown`. On a verify machine under load, starting the mock took more than the remaining second, so the "version lands on the row" test failed although the product behaved correctly. The mock now waits 0.2 seconds. No product code changes.

## What to Tell Your User

Nothing changes for you. One of our own tests was failing on a busy test machine for a timing reason; it no longer does.

## Summary of New Capabilities

None.

## Evidence

On 2026-11-15 the test file is named in six Local Verify run-details on the Mac Studio (PRs 3186, 3190, 3072 and three main runs); on PR 3072 at 22:14Z it failed outright with "no cliVersion 2.1.322 on the launch record: expected undefined to be defined" on a change that touches no launch code.
