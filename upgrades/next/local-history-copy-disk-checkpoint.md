# Upgrade Guide for Local History Copy Disk Checks

## What Changed

The server can compare the filesystems used to stage and save local history, and estimate the allocation needed for individual writes.

## What to Tell Your User

Local history import is still being built. This checkpoint adds internal disk checks and leaves the app flow unavailable.

## Summary of New Capabilities

There is no new control to use.

## Evidence

Focused checks cover directory replacement, device mismatch, and allocation rounding. The checks are internal and do not establish a production reservation margin.
