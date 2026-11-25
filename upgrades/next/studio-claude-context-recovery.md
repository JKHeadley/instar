# Claude Code conversation recovery

## What Changed

The built-in Claude Code compaction hook has a deadline that covers the time allowed for its local requests. Each optional HTTP read now has a deadline. Fresh installations and updates use the revised compact-hook timeout.

## What to Tell Your User

A slow local response is less likely to interrupt Claude Code while it restores a compressed conversation.

## Summary of New Capabilities

The existing compaction hook can complete recovery when its local reads take more than five seconds.

## Evidence

Studio recorded a timed-out compact hook after 5,023 milliseconds. An isolated slow-server reproduction withheld all recovery output under the old budget. The migration and hook integration test delivered recovery under the revised budget.
