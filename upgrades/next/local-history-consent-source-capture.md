# Verify which capture belongs to a copy approval

## What Changed

The internal consent check now matches the captured files in order before it can produce the source details for an approval slip.

## What to Tell Your User

The approval check now rejects a capture that belongs to another owner or contains different files. Copying real conversation history remains paused.

## Summary of New Capabilities

The check is internal and depends on a trusted source record. It adds no app control or copy permission.

## Evidence

Synthetic files pass through the staging pipeline. The consent check accepts the exact capture and rejects absent or mismatched captures.
