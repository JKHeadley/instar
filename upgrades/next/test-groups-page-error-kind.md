## What Changed
A Telegram test-group step that breaks inside the web page (not a refusal from Telegram) now reports the error `kind` (for example `TypeError`) and, when it is plain short text, its `message`, in the reply and the test-group audit log. Text with quotes, angle brackets or other characters is never included.

## What to Tell Your User
Nothing to do. When a Telegram test group step fails, I can now see what broke and fix it.

## Summary of New Capabilities
- Test-group failures carry `kind` and a filtered `message` when the page itself failed.

## Evidence
- `tests/unit/telegram-origin/test-groups-page-scripts.test.ts`: a TypeError reports kind and message; a message with quotes and angle brackets is dropped; a Telegram error still reports code and type. Telegram origin suite 559/559.
