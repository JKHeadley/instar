## What Changed

- Possible blockers that the deferral checker records now hold the message text, not the whole command that sent it, and link signatures or tokens are masked. The dashboard's Plans page shows older entries the same tidy way.

## What to Tell Your User

The "In the way" list on Plans now reads as plain sentences instead of shell commands, and it no longer shows private link signatures.

## Evidence

- On a live agent all 50 stored entries were whole reply commands, one with a signed private link, printed verbatim on the Plans page. Unit tests run the real rendered hook against a local server and check the posted text, and check the dashboard's cleanup of stored rows.

## Summary of New Capabilities

None.
