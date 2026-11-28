# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Autonomous runs now stop at their saved end time, including when the timestamp contains fractional seconds and a UTC offset. Existing installs with a stock stop hook receive the fix on update. If a declared deadline and its fallback are both unreadable, the hook logs a warning and leaves the run active.

## What to Tell Your User

Time-limited autonomous runs stop when their scheduled time runs out.

## Summary of New Capabilities

The stop hook accepts the timestamp formats used by current and older run records.
