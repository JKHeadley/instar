<!-- bump: patch -->
## What Changed

Quiet by Default no longer holds back buttons only the owner can answer. `TelegramAdapter.sendOfferList` (the Chief of Staff note with Unpark / Confirm-done, the Chief of Staff pause ask, the machine-enrolment offer) was sent with no category, so the gate recorded it in the quiet feed and the send returned nothing. These sends now carry a new protected category, `owner-decision`. It is stamped only in-process, never by a request, and only when the caller set no category of its own. The gate delivers it, up to 10 per topic per 10 minutes, and it cannot be configured or redirected. The owner-pause source floor also now refuses a marker whose date is not the cited message's date (`date-mismatch`).

## What to Tell Your User

Questions I send you with a button, like "Unpark this project?" or "Pause this project?", now reach you instead of sitting in the quiet notifications list. Routine reports stay quiet as before.

## Summary of New Capabilities

- Buttons only you can answer (project unpark, confirm done, pause or resume, machine enrolment) are always delivered.

## Evidence

Unit tests: the category is protected and has no producer mapping; the gate delivers it while an uncategorized report on the same topic stays quiet; budget; adapter delivery vs quiet; a caller's envelope is kept; date-mismatch. Live: the branch's adapter and gate, enforcing, with the real Bot API in a test group: the report was recorded quiet and the offer was delivered as Telegram message 3.
