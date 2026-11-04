# Topic workspaces no longer run out after 30 topics

<!-- bump: patch -->

## What Changed

Each code-working topic gets a workspace record, capped at 30. Nothing ever marked a record finished, so after 30 topics every new topic session failed with `Max active bindings (30) reached`. At the cap, Instar now drops the record of the oldest workspace no live session is using. The folder and branch stay, and the topic re-adopts them if it returns. It refuses only when all 30 are in live use, and says so.

## What to Tell Your User

If starting a new conversation topic ever failed with a "max active bindings" error, that's fixed: old idle topics no longer block new ones.

## Summary of New Capabilities

None. This is a fix.

## Evidence

On Echo, 2026-11-03 17:20 PST, all 30 bindings were `active` (oldest from 2026-10-28) and two new topic spawns failed with the cap error. `tests/unit/WorktreeManager-binding-cap.test.ts`: 3 cases, 2 of which fail on the old code.
