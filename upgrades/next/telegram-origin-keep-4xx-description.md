# A Telegram refusal now says why in the server log

## What Changed

When Telegram refused a send with a 4xx answer (for example 400 Bad Request), the server recorded only `telegram-400` and threw Telegram's own explanation away, so the cause could not be read from any log, record or route. On 2026-11-27 every reply to one topic was refused this way for hours and nothing on the machine said why.

Now the server writes one log line for each refused send: the operation, the method, the status, Telegram's own description (bounded to 160 characters, single line, anything shaped like a bot token blanked), and the shape of the request that was refused: every parameter name, text and captions as their length only, formatting entities as type@offset+length, ids and modes as their value, reply and link-preview settings one level deep. No message text is written. Sending, retrying and the recorded outcome are unchanged.

## What to Tell Your User

Nothing changes in your conversations. If Telegram ever refuses my messages to you, I can now see exactly why and fix it quickly.

## Summary of New Capabilities

No new capability. Telegram refusals are logged with Telegram's reason and the refused request's shape.

## Evidence

Before: 2026-11-27, topic 2 on the Studio, five replies refused with `telegram-400` from 11:34 PT; the Studio's server log, the origin store, the outcome route and attention items held no description, and the stored request is cleared at dispatch. After: tests/unit/telegram-origin/origin-service.test.ts checks the log line for a refused send (description kept, token blanked, text only as a length), the description bounding and flattening, and the request shape for a body with text, entities, reply parameters and link preview options, with no private text in the output.
