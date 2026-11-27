# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The quiet-notification decision ledger (logs/notification-selectivity.jsonl) now writes a burst of decision rows as one append instead of one write per row. The rows, their order and the format are unchanged, and rotation is still checked before each write. Closing the notification gate after a large burst no longer waits on a long chain of tiny writes; in the 1000-send test it took 6.5 to 10.9 seconds on a loaded machine.

## What to Tell Your User

Nothing changes for you. When lots of routine notifications are quietly recorded at once, I now note them on disk in one go instead of one at a time, so shutting down and restarting stays quick on a busy machine.

## Summary of New Capabilities

Faster recording of bursts of quiet notifications (no visible change).

## Evidence

tests/unit/notification-selectivity.test.ts: a new case shows 1000 queued rows become exactly one append, all in order, and a later row lands in a second append. The file passes 29/29 in three consecutive runs; the type check is clean.
