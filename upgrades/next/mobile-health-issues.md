## What Changed

New owner-only read `GET /mobile/health-issues`: why `/health` says degraded, each reason sorted into user-affecting, internal or unclassified from a declared table, with plain words, details and a next step. `/health` is unchanged. The console gains a Health page at `#/capacity/health`, Home counts only what affects the person, and Sessions can open with a question ready in the message box.

## What to Tell Your User

"Degraded" now only shows when something really affects you. Every problem says what it means, with a button to the fix when there is one and a way to ask me about it. Small internal things I handled myself stay out of the way, in a details section.

## Summary of New Capabilities

`GET /mobile/health-issues` (owner phone or bearer) and the console Health page. An unknown problem shows as not sorted yet and never reads as healthy.
