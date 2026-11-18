<!-- internal-only -->
# Confirm next-grant setup in the locked-Mac proof

## What Changed

The takeover proof stops when its next viewer grant cannot open, and its verdict requires explicit successful opening evidence. It can no longer report success from a locked final screen alone after this setup failure.

## Evidence

Regression tests reproduce the old false pass and cover timeout, hidden controls, successful opening, missing/failed evidence, and recovery. All 78 tests in the affected harness test file pass without exclusions. No live-Mac proof or fleet enablement is claimed.
