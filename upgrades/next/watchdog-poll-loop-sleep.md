# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The stuck-command watchdog no longer interrupts a quiet poll loop or Monitor watch script while it is sleeping between checks. When a timed `sleep` runs below a long-lived command, or was seen there in the last five minutes, the command is a protected wait (`poll-loop-sleep`). The two-hour protected-wait limit still applies, and a loop that stops sleeping loses the protection after five minutes.

## What to Tell Your User

My background watches stop being cut off. When I'm waiting on something, such as a sign-in finishing or a turn to run tests, by checking every few seconds, the safety check that stops stuck commands now recognizes that as waiting, not being stuck. Truly stuck commands are still stopped as before.

## Summary of New Capabilities

Quiet poll loops and watch scripts are no longer interrupted as stuck while they sleep between checks.

## Evidence

Unit cases in tests/unit/session-watchdog-timed-sleep-and-notice.test.ts: a watch script and a wrapper with a sleeping child are protected; a loop sampled mid-check is protected only within five minutes of its last observed sleep; the two-hour bound holds; `sleep infinity` is no evidence.
