<!-- bump: patch -->
## What Changed
An ordinary wait for a free session slot no longer appears in Needs you. It remains on Health, with a status dot on the dashboard's Agent door. Failed status reads show an unknown dot.

## What to Tell Your User
The dashboard keeps ordinary capacity waits out of your action list. You can still see why work is waiting under Agent → Health.

## Summary of New Capabilities
The existing health-issues read marks session capacity with optional `requiresUserAction: false`; the shared dashboard and owner-phone Needs-you read honors it. No session limits, permissions or scheduling behavior change.
