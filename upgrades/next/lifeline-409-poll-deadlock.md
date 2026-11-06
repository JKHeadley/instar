## What Changed

A machine that took over an agent after a network split could stay silent on Telegram. Its lifeline remembered the "someone else is polling" (409) errors from the split and, since #2759, refuses to start polling while that count is above zero. Only a successful poll reset the count, so it never polled again. Now a 409 counts as evidence for two minutes only (twice the longest backoff), so an old count lapses. A standby also stops reporting itself as stuck in a 409 fight to the watchdog. The rule against a second poller is unchanged.

## What to Tell Your User

If your agent runs on two machines and the connection between them drops, the machine that takes over now answers your messages. Before, it could stay quiet until it was restarted.

## Summary of New Capabilities

None. This is a bug fix.

## Evidence

Two-server drill (topic 137054), 2026-11-06 00:01Z: fresh-2 held the lease with `shouldPoll:true` while `lifeline-poll-active.json` stayed `pollingActive:false`, and the mock Telegram API logged no poll from it for 20 minutes. New tests in `tests/unit/lifeline-poll-start.test.ts` reproduce the sequence and fail without the fix.
