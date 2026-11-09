## What Changed
A failed Telegram test-group step now says why. The reply from `/telegram/browser/PROFILE/test-groups` (list, create and delete) and the test-group audit log include Telegram's own error `code` and `type` when the browser page reported them, next to the failed `step`. Nothing about what is allowed changes.

## What to Tell Your User
Nothing to do. If I ever can't make or remove a Telegram test group, I can now see Telegram's exact reason and fix it instead of guessing.

## Summary of New Capabilities
- Test-group failures carry `code` and `type` in the reply and in `state/telegram-test-groups.jsonl`.

## Evidence
- `tests/unit/telegram-origin/test-groups.test.ts`: a page failure with code 400 and a type reaches the reply and the audit line; the next list starts clean. 58/58 pass.
