# Codex conversation recovery

## What Changed

The conversation hook checks for a Codex recovery summary after checking whether context delivery is suppressed and before choosing which context to print. Fresh installations write the same hook as updates. The Codex hook timeout covers the bounded requests made during recovery.

## What to Tell Your User

Codex can now receive its recovery summary after compressing a long conversation even when its normal request for recent messages succeeds.

## Summary of New Capabilities

The existing Codex recovery check runs on the current prompt context path.

## Evidence

The real shell hook against an isolated HTTP server reproduced the skipped offer before the fix. The regression exercises the offer, acknowledgement, and output after the fix. Unit and lifecycle tests cover installation parity, the recovery service, and canary evidence.
