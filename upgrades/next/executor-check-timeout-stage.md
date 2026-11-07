# Feedback workers record which check ran out of time

## What Changed
When a feedback worker's check stopped at its time or output limit, the record held only the limit's name, so nobody could tell whether the base, head, lint or related-tests run was responsible, and the check folders are deleted with the attempt. The latest check failure now also names the check and keeps the end of its output. The failure reason itself is unchanged.

## What to Tell Your User
When a feedback fix attempt runs out of time, I can now see which check was slow and fix the real cause.

## Summary of New Capabilities
- The executor status's last check failure names the check that hit a time or output limit and keeps the end of its output.

## Evidence
Unit: tests/unit/feedback-factory/execute-service.test.ts, a scripted lint timeout keeps reason limit:command-wall-clock and records "during the lint check" plus the command's output. Echo's audit log since 2026-11-03 holds 8 limit:command-wall-clock failures that name no check.
