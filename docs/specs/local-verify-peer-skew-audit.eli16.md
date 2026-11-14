# Recording when a helper machine is skipped — plain overview

When several machines share the job of testing pull requests, the coordinating machine hands work to helpers. It only trusts a helper running exactly the same test logic, so it compares two fingerprints: the verifier version and the policy hash. If they differ, it skips that helper. That safety rule is correct and it stays as it is.

The problem is that the skip was silent. On 2026-11-06 one helper, the M5, stopped getting work around 13:13 UTC. Its update had installed, but its restart was waiting for long-running sessions, so it kept running older test logic. For more than four hours the log showed nothing at all: no refusal, no error, no busy answer. It looked the same as a helper with nothing to do, so the lost capacity went unnoticed.

This change adds two log lines. The first says "skipped this helper, here are the two versions", written once per version change rather than on every check. The second says "this helper matches again". Nothing else changes: the same helpers are skipped, the same work goes out, and no new network calls are made.

What already exists: the skip itself, the helper health tracking, and the audit log. What is new: only those two log events and a small in-memory note that stops them repeating.

Safeguards: the code cannot block or delay anything, because it only writes a line. If it turned out to be wrong, reverting one commit removes it with no data to clean up.

There is nothing to decide here. The larger question, whether a helper should be allowed to restart onto new test logic while long-running sessions are open, is a separate design question and is not changed by this work.

## The second change: updates now wait for helpers

Each server restart changes a number the helpers' work is tied to, so any test a helper is partway through gets thrown away and started again. An earlier change (#2835) made helpers' work visible in a file so a restart could wait for it. That did not work in practice, because the program that performs restarts on the machine, the lifeline, keeps running the code it started with and did not know about the file. On 2026-11-06 ten helper runs, about 110 machine-minutes, were lost this way, and no hold happened at all.

The fix puts the same check where the update decision is made: the updater, inside the server, which always runs current code. While a helper has accepted a test and is still answering, the update waits, normally for at most 21 minutes per test. As soon as the test finishes, the update goes ahead.

The tradeoff is that an update usually arrives up to 21 minutes later, and no new tests start during that wait. If the update has also been held by something else, such as open sessions, for over two hours, new tests can start again and waits can chain, up to the existing limit of about 4 hours. Local test runs already behave this way. If a helper goes quiet, the wait ends in about two minutes, and a forced update ignores it. Reverting removes it with nothing to clean up.
