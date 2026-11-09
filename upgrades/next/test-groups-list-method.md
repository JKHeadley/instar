## What Changed
Listing Telegram test groups works on the real web Telegram: it uses Telegram's chat search for the "Instar test" title instead of a method the web app does not include ("No method messages.getAllChats found" on the first live run). Only groups this agent made, with its marker, are ever listed or deleted.

## What to Tell Your User
Nothing to do. I can now make and remove my own Telegram test groups for live checks.

## Summary of New Capabilities
- Test-group list via `contacts.search`.

## Evidence
- `tests/unit/telegram-origin/test-groups-page-scripts.test.ts`: the list uses contacts.search with the title prefix, never getAllChats; an operator chat reads not present; a full page marks the read incomplete. 73/73 in the test-group files.
