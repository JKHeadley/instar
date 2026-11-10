## What Changed
The Telegram test-group list also reads the newest 100 chats from the chat list and merges them with the search, so a group made moments ago is found and can be deleted (live: search did not return a group made a minute earlier). Marker checks are unchanged.

## What to Tell Your User
Nothing to do. Test groups I make for live checks are now found and removed reliably.

## Summary of New Capabilities
- Test-group list merges `messages.getDialogs` with `contacts.search`.

## Evidence
- `tests/unit/telegram-origin/test-groups-page-scripts.test.ts`: a group search does not return is found through the chat list; an operator chat reads present but is never a candidate.
