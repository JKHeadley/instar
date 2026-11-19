# Older server's resource reading shows on the serving machine
<!-- bump: patch -->

## What Changed
When the resources answer has no machines list (an older standalone server), its reading attaches to this machine's card and detail sheet, even if a peer shares its label. Pooled answers are unchanged.

## What to Tell Your User
On the Machines page, "what's using it" now shows on the right machine when one of your machines runs an older version.

## Summary of New Capabilities
No setup or new permissions. Display correction only.

## Evidence
Machines page DOM tests with the pool on and off. See upgrades/side-effects/dashboard-legacy-machine-reading.md.
