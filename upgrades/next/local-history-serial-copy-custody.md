# Upgrade Guide for Serial Local History Copy Custody

## What Changed

Staging can track an internal copy child and retain its temporary files until that child has closed.

## What to Tell Your User

Local history copying remains in development. This checkpoint adds internal safeguards for cancellation and shutdown.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused tests use real inert children and cover cancellation, shutdown and registration failure.
