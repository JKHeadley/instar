# Feedback setup failures keep the actual error

## What Changed
When a fix attempt's setup failed, the record kept the first 300 characters of the error. For a git command those are all flags, so the real error was lost and the failed step read "other". The record now keeps the start and the end of the message, names the step from the full message, and notes the signal when a command was killed.

## What to Tell Your User
When a feedback fix attempt fails during setup, I can now see the actual error and fix the real cause.

## Summary of New Capabilities
- The executor status's last setup failure shows the real error and the signal if a command was killed.

## Evidence
Unit: tests/unit/feedback-factory/execute-reroute-capacity.test.ts. Live on Echo, 2026-11-06: attempt f27da149:a6 recorded only git flags and step "other".
