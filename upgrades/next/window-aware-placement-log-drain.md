# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A new account placement starts an asynchronous log write. An orderly server shutdown drains pending placement records, and an empty maintenance flush can no longer keep later records stuck in memory.

## What to Tell Your User

The account placement history updates more reliably and survives an orderly restart. Placement rules are the same.

## Summary of New Capabilities

The existing placement history is less likely to miss session starts.

## Evidence

The full focused unit, HTTP, and initialized-server files passed. Tests cover a placement after an empty flush and a second placement arriving during an append before shutdown.
