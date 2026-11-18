# Needs-you overflow is visible
<!-- bump: patch -->

## What Changed
If the Needs-you response contains fewer rows than its total count, the strip states how many rows are available and omitted. Expansion counts only received rows and keeps source failures visible.

## What to Tell Your User
A long Needs-you list now tells you when some items are missing from the displayed list. Its expansion button counts only the items it can show.

## Summary of New Capabilities
No setup or new permissions. This makes the existing list limit visible; it does not add pagination.

## Evidence
Front-door and needs-read regression tests, independent review, and Chromium checks at desktop and phone widths. See upgrades/side-effects/dashboard-needs-overflow.md.
