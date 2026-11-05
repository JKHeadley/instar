# Job silence alert

## What Changed

Enabled jobs now send an operator alert after repeated gate skips or a missed completion window. Machine-pinned jobs on the serving machine are surfaced. A successful completion closes the item.

## Evidence

Focused unit tests cover gate skips, overdue work, recovery and read-only standby behavior. Typecheck passes.

## What to Tell Your User

If a scheduled job keeps skipping or has not completed on time, the agent now alerts you with the affected job name instead of staying quiet.

## Summary of New Capabilities

Default-on scheduled job continuity alerts.
