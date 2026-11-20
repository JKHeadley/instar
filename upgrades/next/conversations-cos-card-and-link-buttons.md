<!-- bump: patch -->
## What Changed

- Conversations page: with the Needs-you list on screen, the Chief of Staff card shows only the check-in reminder (paused or pausing soon) instead of repeating every project wait the list already shows (`chiefOfStaffCardRows`).
- Console buttons: a link styled as the primary button centres its label, and primary buttons grow to fit a two-line label (`min-height`).

Overview: `docs/specs/conversations-cos-card-and-link-buttons.eli16.md`.

## What to Tell Your User

On your phone, the Conversations page no longer shows the same waiting projects twice, so the page itself starts on the first screen. Buttons with longer labels read properly.

## Summary of New Capabilities

- None (layout only).

## Evidence

- Unit: `tests/unit/console-chief-of-staff-needs.test.ts`; console suite green. Phone screenshots before and after (390x844).
