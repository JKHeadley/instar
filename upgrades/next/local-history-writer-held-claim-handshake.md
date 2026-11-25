# Upgrade Guide for Writer-Held Local History Claim Handshake

## What Changed

The parent can inspect a verified claim estimate before the worker releases the writer lock.

## What to Tell Your User

Local history copying remains in development. This checkpoint helps the server check a planned write while it still holds exclusive access.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Real worker tests verify writer contention during the observation and lock release after discard or policy refusal.
