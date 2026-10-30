<!-- internal-only -->
# Feedback drain integration fixture

## What Changed

Each feedback drain integration case now gets a unique failure-file path, so a reused temporary server port cannot make a successful case appear failed.

## Evidence

The focused integration test covers both script failure and success paths. The post-merge CI failure on PR #2451 was a success case reading a prior 403 failure record. No production code changed.
