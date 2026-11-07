# Refresh the existing feedback repair with current main

PR #2885 already contains the fix for the test that is holding ordinary merges: its diagnosis-peer tests use a unique temporary attempt name, so another account's leftover directory cannot break the suite. It also contains two previously reviewed feedback-executor improvements: reporting a lasting GitHub outage and keeping the name and output of a check that timed out. This update keeps those existing changes in the same PR. It creates no new replacement fix.

Main subsequently gained PR #2887, which keeps a feedback attempt alive when its own machine re-acquires the lease during preparation, while still stopping an attempt when ownership actually moves away. Both branches added tests at the same location in the executor's test file. Git could not choose which group to keep, and verification stopped at that conflict before it could run the tests.

The resolution keeps both groups. The source files merge automatically; no new source behavior is designed here, no permission is broadened, and no test assertion is removed. The existing unique temporary-name fix is preserved exactly. The resulting merge commit includes both main and all three original PR commits, so pushing it updates the existing PR without rewriting its history.

Focused verification runs the complete executor service test file and the diagnosis-peer test file together. The existing full verifier remains the merge authority. The update stays behind the same main-health and merge gates. If the resolution is wrong, revert this merge update or restore the previous PR head; no production data has changed.
