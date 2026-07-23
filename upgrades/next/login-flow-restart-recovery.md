---
title: "Pending sign-ins recover cleanly after restart"
audience: "operators"
---

## What Changed

Unfinished sign-ins regain a live backing process after server restart. Codes
submitted to a dead or vanished flow now receive an honest expired response,
with a fresh replacement created when the account still needs sign-in.

## What to Tell Your User

If a restart interrupts sign-in, the dashboard restores a fresh flow instead of
showing a technical submission failure.

## Summary of New Capabilities

- Restores unfinished login flows during server boot.
- Replaces dead flows without ever typing their stale code.
- Shows explicit expired and fresh-ready states in the dashboard.
