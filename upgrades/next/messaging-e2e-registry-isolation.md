<!-- internal-only -->

# Isolate the multi-agent messaging E2E registry

## What Changed

The test now creates an isolated temporary agent registry and unique agent names before starting its two real servers. It asserts that discovery sees only those agents and restores its environment after teardown.

## Evidence

The branch builds successfully. Full CI and Local Verify are required before merge.
