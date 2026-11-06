<!-- bump: patch -->

## What Changed

The console's Sessions page now uses the width of a desktop window: a wider list, a headline on one line, and a full-height panel beside it, open session or not. A "Session settings" button beside "+ New session" opens just the defaults new sessions start on (door and model), with Save and Clear. The word a person reads for a door now comes from one constant in the console and in the app's server answers, so it can be renamed in one place.

## What to Tell Your User

The Sessions page in the dashboard now fills the screen on a computer instead of sitting in a narrow strip. There's a "Session settings" button next to "+ New session" where you can change which door and model new sessions start on.

## Summary of New Capabilities

- A "Session settings" button and sheet on the console's Sessions page for the new-topic default door and model

## Evidence

DOM tests drive the button and both Save and Clear with the exact request bodies. Screenshots at 1280x728, 1440x900 and 390x844 against sample data show the layout.
