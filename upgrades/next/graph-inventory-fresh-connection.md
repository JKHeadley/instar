<!-- bump: patch -->

## What Changed

Managed graph witnesses and registered peer witnesses now open a fresh HTTP
connection when starting a signed inventory export. A closed idle
connection can no longer interrupt that request through socket reuse.

## What to Tell Your User

The conversation graph is less likely to become temporarily unavailable
when it asks another machine for its inventory after a quiet period.

## Summary of New Capabilities

None. This improves reliability of the existing signed inventory read.
