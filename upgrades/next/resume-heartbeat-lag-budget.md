## What Changed

The resume heartbeat integration test allows up to 500 milliseconds of event-loop scheduling delay, matching its existing health-response budget. A busy Studio run measured 294 milliseconds of timer lag. The test still checks that the heartbeat bounds synchronous archive work, limits file lookups and lets the health endpoint answer during the asynchronous lookup.

## What to Tell Your User

The verification run is less likely to fail because a busy machine briefly delayed a test timer.

## Summary of New Capabilities

No new runtime behavior. This change adjusts one timing assertion in the verification suite.
