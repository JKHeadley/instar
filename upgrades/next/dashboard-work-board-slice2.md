# Work cards show why you, what they are about, and who wrote them
<!-- bump: patch -->

## What Changed
The opened card shows Why you under the recommendation and an About line (pull requests by number, plans by kind); the Chief of Staff's own cards are tagged. Needs-you rows linked to a card show a link to it beside the row.

## What to Tell Your User
- **Why you**: "Every card I raise now says why it needs you, right under my recommendation."
- **Chief of Staff cards**: "When a project is waiting on you, the Chief of Staff opens a card for it, marked as its own."
- **Needs you**: "If something in Needs you has a card, there's a link to it next to the row."

## Summary of New Capabilities
No setup. Shows the card fields and Needs-you links added by the server's work-board slices.

## Evidence
Slice 2 unit and page tests and Chromium checks at phone and desktop widths. See upgrades/side-effects/dashboard-work-board-slice2.md.
