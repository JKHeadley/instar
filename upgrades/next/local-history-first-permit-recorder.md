# Upgrade Guide for First Local History Copy Permit Persistence

## What Changed

The server has an internal record that can persist the first write permission alongside the operation state in one database transaction.

## What to Tell Your User

Local history copying is still in development. This checkpoint prepares the internal record needed to recover an interrupted copy.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused SQLite tests check persistence after reopening, rollback, and refusal when the preview record changes.
