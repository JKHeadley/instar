# Finished work starts folded
<!-- bump: patch -->

## What Changed
The Work board starts Done and Archived folded with their totals visible. Expanding a history lane reveals its cards and paging together. An explicit later Done page opens automatically; refresh preserves a user's expansion choice.

## What to Tell Your User
Done and Archived now start folded on Work. Open either heading when you want to look back at finished work.

## Summary of New Capabilities
No setup or new permission. The history headings expand by touch, click or keyboard.

## Evidence
DOM regression coverage in tests/unit/console-work-model.test.ts and independent review. Browser checks at desktop and phone widths verify toggles, refresh and layout. See upgrades/side-effects/dashboard-work-history-folds.md for final validation.
