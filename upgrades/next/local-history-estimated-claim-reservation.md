# Upgrade Guide for Estimated First Claim Reservations

## What Changed

The internal copy lane can reserve space for the first claim using its verified preview and the actual destination volume's block size.

## What to Tell Your User

Local history copying is still in development. This checkpoint connects the first write’s disk estimate to the space the server holds while the worker is active.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks cover the combined charge, cancellation, invalid receipt binding, and a block size that does not match the destination volume.
