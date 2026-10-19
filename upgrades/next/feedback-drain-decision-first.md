# Feedback Drain page opens on what needs you

## What Changed

The dashboard's Feedback Drain tab now opens with one box: a sentence saying whether anything
needs the operator, one line saying why, and at most one button. The button opens the matching
approval card, scrolls to it and puts the cursor in the PIN box (for a fix waiting on GitHub it
opens the pull request). The approval cards moved into a closed "Approvals and settings" drawer
and the drain's counters into a closed "More detail" drawer, the same shape as the Process
Health tab. No approval, route or PIN rule changed.

## What to Tell Your User

The Feedback Drain page now tells you straight away whether it needs you. If it does, there is one
button to press. If it says "Nothing here needs you", there is nothing to do. The numbers are
still there under "More detail".

## Summary of New Capabilities

- None. A clearer layout for an existing page.

## Evidence

- `tests/unit/feedback-drain-headline-ui.test.ts`: the headline is calm with no button when no
  card has an approval pending, points at the right card for each pending item, leads with the
  most important and counts the rest, links only to GitHub pull requests, and the page puts the
  headline before closed drawers holding the cards and counters.
- Rendered at phone width in headless Chromium: one box, one full-width button, no horizontal
  scroll.
