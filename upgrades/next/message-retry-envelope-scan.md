# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Scheduled message retries check file metadata asynchronously and reuse the retry metadata for unchanged messages. A message that may need action is read again before the retry manager acts.

## What to Tell Your User

Large message stores can make the server slow to respond during retry checks. The server now gives other requests a chance to run during that scan.

## Summary of New Capabilities

Message retry scans reuse metadata for unchanged envelopes and detect external file replacements.
