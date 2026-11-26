# Upgrade Guide for Sealed Local History Preview Staging

## What Changed

Upload staging can keep one sealed preview for an explicit request and return the same preview after a lost reply. The expiration time stays tied to the original upload.

## What to Tell Your User

Local history import is still in development. The server can now preserve an internal preview across a request retry. The Mac app import screen is still being connected.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused real-worker tests exercise preview publication, replay, writer contention, owner revocation, cancellation and expiration. The complete import journey remains in development.
