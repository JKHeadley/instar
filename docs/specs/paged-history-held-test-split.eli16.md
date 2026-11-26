# Schedule four history tests in two groups

These tests check how a machine handles private conversation history during recovery. They use real graph storage and include a check from a separate process. The verifier can schedule two files independently, so the checks now run in two groups of two.

The original test file took 174.534 seconds during an earlier full run. The two groups accounted for 91.367 and 83.167 seconds of that run. Each case keeps its original assertions, time limit and cleanup. The full verification schedule and which test files have timing history will determine whether the split saves time overall.
