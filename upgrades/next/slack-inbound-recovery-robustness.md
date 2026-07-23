---
title: "Slack inbound recovery survives thread keys and half-open sockets"
audience: "operators"
---

## What Changed

Slack restart recovery now converts thread-scoped session keys back to raw
channel IDs before reading history. Silent Socket Mode connections are rotated
instead of being trusted after an ignored JSON ping.

## What to Tell Your User

Slack messages are now recovered reliably after a restart or a silent broken
connection, including in channels that use thread-scoped sessions.

## Summary of New Capabilities

- Recovers missed Slack messages without sending thread routing keys to channel
  APIs.
- Bounds silent half-open Socket Mode connections with an automatic reconnect.
