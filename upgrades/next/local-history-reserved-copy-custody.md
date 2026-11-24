# Upgrade Guide for Reserved Local History Copy Custody

## What Changed

Staging can hold a dedicated disk reservation for an internal copy child when the destination folders already exist. Cleanup releases the reservation after the child closes and its registered temporary folder is settled.

## What to Tell Your User

Local history copying is still in development. This checkpoint adds disk accounting for cancellation and shutdown.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused tests cover missing folders, cancellation, shutdown, a failed registration and a destination folder replacement.
