# Reconnect the optional relay with a fresh lease

## What Changed

The test relay can reconnect after an interruption while the same machine still has a valid lease. It slows retries and stops when the caller cancels it.

## What to Tell Your User

The optional relay remains off. The reconnect behavior is being tested locally.

## Evidence

Loopback tests check an updated lease after disconnect, refusal of another holder, and shutdown of active and retrying sessions.
