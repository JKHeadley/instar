# Upgrade Guide for First Claim Disk Estimation

## What Changed

The internal copy preflight can estimate the disk space needed for the first claim after checking that the selected files and destination still match the preview.

## What to Tell Your User

Local history copying is still in development. This checkpoint adds an internal disk estimate before the first write.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks cover exact copy intent binding, stale destination refusal, and exceeding the supplied disk ceiling.
