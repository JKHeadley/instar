# Side-effects review: the feedback-triage lifecycle test waits on its background ticks to a deadline

## What changes
Test-only. `tests/e2e/feedback-triage-lifecycle.test.ts` waited for two background results with a fixed loop of 200 x 10 ms, about 2 s of sleeping:
- the drain tick creating two feedback initiatives (:139);
- the triage tick reporting its run in the summary (:156-159, and :280-283 in the spare-account case).
Each loop is replaced by `waitForBackground`, which polls the same condition every 25 ms up to 30 s. If the condition isn't met, it throws a message naming the step and what it last saw (initiative count plus drain status, or the triage summary body). The assertions after each wait are unchanged.

## Why
Main b2f53172 failed this file in the Studio rerun at 07:39 PT on 2026-11-27, on a loaded machine (the e2e shard ran 1332 s; the file's recorded duration is 7.3 s). The retained record names only the file, with an empty message. The three fixed 2-s waits on background work are the plausible cause. A direct await is not available: both routes answer 202 and run the work in the background, the triage service's awaitable `tick()` would stop exercising the HTTP route this lifecycle test proves, and neither exposes a completion promise.

## Behavior
No production code changes. A healthy run finishes as before. On a loaded machine the test now waits up to 30 s per step, well inside the e2e `testTimeout` of 120 s. A genuine failure now names the step and its last observed state instead of failing a later assertion with no context.

## Risks considered
- **Masking a real slowdown:** a tick that takes longer than 30 s still fails, with a diagnostic.
- **Rollback:** revert this commit.
