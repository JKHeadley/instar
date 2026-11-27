# Recovering a clean unit run after a Vitest reporting timeout

A machine can finish the unit tests but lose the message a Vitest worker sends to report a progress update. That leaves the verifier with a failure even when the completed test report shows zero failures. This change gives that precise situation one chance to recover within the time first allotted to the unit tests.

The verifier checks that the first report covers every expected file and that the test totals agree. It checks that the separate worker report contains only the known task-update timeout and accounts for every error. It then runs the entire unit lane again with the time remaining. The second run must exit successfully, report zero worker errors, and show matching coverage for every file. Its result still goes through the existing verifier and merge rules.

A missing result, a different worker fault, or a failed test keeps the run on its existing failure path. If the timeout returns, the verifier retains both process receipts. The retry applies to a full unit run in one process, where the verifier can prove the report covers the whole lane. The change adds no operator controls and requires no configuration migration.
