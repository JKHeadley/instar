# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When a delayed plan save finishes, Plans refreshes. The response closes its original dialog if it is still open. A newer dialog stays open.

## What to Tell Your User

You can close a plan dialog or open another one while a save is pending. The Plans list updates when the save finishes.

## Summary of New Capabilities

Plans keeps newer dialogs open when an earlier save finishes.
