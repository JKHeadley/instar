# Close work cards as Done or Not important from the dashboard
<!-- bump: patch -->

## What Changed
The Work page offers Done (with a closeout note) and Not important (with a reason) in place of Archive on cards from a server that records closes, asks for the note before the PIN, shows who closed a card and why, and reopens a closed card by naming its close. Cards are coloured by whose turn it is. Older servers keep the plain Archive.

## What to Tell Your User
- **Closing cards**: "On the Work page you can close a card as Done with a short note, or as Not important with a reason. I read those reasons before I raise a new card."
- **Colours**: "Light red means a card is waiting on you; light blue means it's moving."

## Summary of New Capabilities
No setup. Uses the close added by the server's work-card closeout change; the PIN is still required.

## Evidence
Closeout unit and page tests, and Chromium checks at phone and desktop widths. See upgrades/side-effects/dashboard-card-closeout.md.
