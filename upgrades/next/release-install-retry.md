# Upgrade Guide — vNEXT
<!-- bump: patch -->
<!-- internal-only -->

## What Changed
The release publisher attempts dependency installation up to three times, waiting fifteen and thirty seconds between failed attempts. Exhaustion preserves the last command's failure status and stops the release. Package publication is not retried.

## Evidence
Five focused tests execute the workflow's Bash block under GitHub's fail-fast options, covering success on every attempt, exhaustion, exit status and placement before the build. Independent review concurred. Complete Local Verify remains required before merge.
