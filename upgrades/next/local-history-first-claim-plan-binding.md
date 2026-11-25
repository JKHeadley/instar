# Upgrade Guide for Local History First Claim Plan Binding

## What Changed

The server can bind the first claim's disk estimate to the exact verified file and destination.

## What to Tell Your User

Local history copying is still in development. This checkpoint helps the server detect a mismatched write plan before it can authorize copying.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks exercise the real worker and verify that changing the file digest, destination or size changes the plan digest.
