## What Changed
A held Telegram reply is no longer thrown away just because the user wrote again. When a reply could not be sent right away (for example, the sending machine was busy), Instar holds it and retries. It used to discard the held reply if anyone, the user included, had written in the conversation since. So a user who wrote "checking in" while waiting lost the very answer they were waiting for. Now only a newer reply from the agent makes a held reply out of date. When a held reply is discarded, that is recorded with a named reason and shown as a dashboard item, never as a chat message.

## What to Tell Your User
If a reply of mine is delayed and you check in, the delayed reply will still reach you instead of disappearing.

## Summary of New Capabilities
- Discarded held replies now appear as a dashboard attention item ("A held reply was not sent because a newer reply reached the conversation first").

## Evidence
- `tests/unit/telegram-origin/queued-reply-supersession.test.ts`: the 2026-11-11 incident regression (a user check-in after two held replies) fails on the old rule and passes on the new one.
- `tests/unit/telegram-origin/session-exception-scan-bound.test.ts` and `tests/integration/session-delivery-reporting.test.ts`: the discarded reply is listed and recorded, and nothing is posted to the chat.
