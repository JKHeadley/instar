# Dashboard project rows: latest report, why it waits, and Ask for an update
<!-- bump: patch -->

## What Changed
The Work page's project rows show the server's latest report, why a project waits on you or stopped, when it was and will be checked, each done item's state in words, and an Ask for an update button. Pause, Mark checked and Finish are named as phone actions (Face ID) and not offered on the dashboard. Older servers show the rows as before.

## What to Tell Your User
- **Projects**: "Each project on the Work page now tells you where it stands and why it needs you. Tap Ask for an update and I'll check it now."
- **Phone actions**: "Pausing, checking off items only you can judge, and finishing a project are on your phone, with Face ID."

## Summary of New Capabilities
No setup. Uses the project row fields and check request added by the server's project-rows change.

## Evidence
Project-rows unit and section tests and Chromium checks at phone and desktop widths. See upgrades/side-effects/dashboard-project-rows.md.
