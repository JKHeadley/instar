# Upgrade Guide for First Copy Permit Progress

## What Changed

The internal recorder can retain a stop request and a late acknowledgement of the first copy write permission.

## What to Tell Your User

Local history copying is still in development. This checkpoint helps the server preserve what it knows about an interrupted copy.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused SQLite tests cover cancellation state, late acknowledgement, replay and rollback.
