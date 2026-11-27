# Retry the tests that actually failed

A verification run can finish tens of thousands of tests and still come back red because one test failed briefly. The verifier already tries some failed test files again. If a file contains lots of other tests, rerunning the entire file takes longer and can make it hard to tell whether the same failure recovered.

With this change enabled, the verifier can run an exact list of up to three failed tests in the checkout it already tested. It includes the parent test names so similarly named tests cannot stand in for the one that failed. The retry has fresh output and uses the remaining verification time. The file’s original successful and skipped checks are still in the final record. Only the specific failure that passes again is marked recovered, and the original failure stays visible.

An incomplete initial report, a file-level setup error, an unhandled error, or an ambiguous test name keeps the original failure. A repeat failure remains a failure. Recurring confirmed flakes go into an internal repair queue and lose their automatic recovery for seven days. That queue never stops a test from running. Echo will try the setting before it is considered for general use.

When a failed test shares a file with other tests, the verifier also reruns the full file. This checks that the failing test can pass alongside its neighbors before clearing the failure.
