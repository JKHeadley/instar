---
title: "Quota reads expose broken credentials and stale measurements"
audience: "operators"
---

## What Changed

Malformed Claude credential JSON now becomes an explicit re-auth-needed state
instead of silently skipping quota collection. Per-account quota reads also
report whether their measurement is stale and how old it is.

## What to Tell Your User

Quota status now says when its last reading is old, and a broken saved login
asks for authentication again instead of quietly disappearing from polling.

## Summary of New Capabilities

- Classifies malformed credential JSON without exposing its contents.
- Marks the affected subscription account `needs-reauth`.
- Adds `staleSnapshot` and `snapshotAgeMs` to per-account quota reads.
