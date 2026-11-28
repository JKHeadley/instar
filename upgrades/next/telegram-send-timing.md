# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Text sends now record bounded network timing and event-loop observations at the actual egress boundary. The records distinguish HTTP headers from errors and omit request content, credentials and destinations. Missing histogram samples remain unavailable. Process utilization is overlapping activity, not attribution. This adds diagnosis without changing delivery policy, deadlines, polling, connections or retries.

## What to Tell Your User

I have added measurements to help explain delayed Telegram replies. They do not change how messages are delivered or prove that the delay has been fixed.

## Summary of New Capabilities

Agents can correlate process-local `[telegram-send-timing]` start and headers/error records when investigating delayed text sends.

## Evidence

Independent implementation review concurred. The allocated enforcing focused invocations passed 64 unit, 4 real-HTTP integration and 5 production-origin lifecycle cases with unchanged source/test hashes. These include diagnostic clock/logging failures, privacy, caller cancellation, real event-loop blocking, idle HTTP waiting, original egress guards and the production origin boundary. Complete coordinator verification remains required before release; no production timing or delivery recovery is claimed.
