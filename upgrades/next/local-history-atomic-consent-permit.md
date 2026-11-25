# Prepare all-or-nothing recording for copy approval

## What Changed

The internal recorder can save the first permission to write and the use of the matching approval in one transaction.

## What to Tell Your User

The test recorder keeps the approval and permission to write together, even if a write fails. Copying real conversation history remains paused.

## Evidence

Private SQLite fixtures verify restart persistence, refusal of duplicate or substituted consent, and rollback of both records and the phase on write failure.
