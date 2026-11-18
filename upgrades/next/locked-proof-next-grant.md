# Confirm next-grant setup in the locked-Mac proof

## What Changed

The takeover proof stops when its next viewer grant cannot open, and its verdict requires explicit successful opening evidence. It can no longer report success from a locked final screen alone after this setup failure.

## Evidence

Regression tests reproduce the old false pass and cover timeout, hidden controls, successful opening, missing/failed evidence, and recovery. All 78 tests in the affected harness test file pass without exclusions. No live-Mac proof or fleet enablement is claimed.

## What to Tell Your User

No new action is needed. This is a proof-harness reliability change; live Mac acceptance and fleet enablement remain separate.

## Summary of New Capabilities

The developer proof harness requires a positively confirmed next grant before accepting takeover evidence. Product authorization and relock policy are unchanged by this harness change.
