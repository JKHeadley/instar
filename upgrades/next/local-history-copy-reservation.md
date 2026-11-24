# Upgrade Guide for Local History Copy Reservation Growth

## What Changed

The disk ledger can increase the budget on an existing empty reservation after checking that the copy destination still matches the original disk selection.

## What to Tell Your User

Local history copying is still in development. This checkpoint adds an internal disk accounting safeguard.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks verify reservation growth and refusal when ownership, disk identity or available capacity changes.
