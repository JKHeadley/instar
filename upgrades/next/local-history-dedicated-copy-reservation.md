# Upgrade Guide for Dedicated Local History Copy Reservations

## What Changed

The server can bind copy disk accounting to one dedicated allocation during a live operation. A failed placeholder creation retains its charge for recovery.

## What to Tell Your User

Local history copying is still in development. This checkpoint adds internal disk accounting and recovery safeguards.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks cover duplicate creation, allocation binding and failure after a durable reservation.
