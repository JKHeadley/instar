# Upgrade Guide for Local History Copy Preflight

## What Changed

The server can reread the full prepared selection and check that the destination still matches the sealed preview before copy admission.

## What to Tell Your User

The local history flow is still in development. This checkpoint adds an internal check for files or destinations that changed after the preview.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks cover the real reader, same-length artifact corruption and a durable destination claim that changes after preview. Copy remains unavailable.
