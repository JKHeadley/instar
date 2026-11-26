# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When a Telegram message is saved in the inbound queue but the router cannot replace its offline conversation owner, Agent Health records the blocked delivery. One record covers retries at the same ownership epoch.

## What to Tell Your User

The dashboard can show when a message was saved while its conversation could not move from an offline machine.

## Summary of New Capabilities

Agent Health records a blocked Telegram delivery caused by an offline conversation owner.
