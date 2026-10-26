# Telegram sends wait long enough for a throttled answer — plain-English overview

## What happened

On the morning of 2026-10-26, every Telegram message Echo tried to send failed for about an hour, in every conversation. The server answered each attempt with "held: outcome unknown", and its log said nothing at all about why.

Measuring inside the running server showed the cause. Telegram had slowed Echo's bot down (it does this when a bot has been busy): any request aimed at a chat was held on Telegram's side for 14 to 33 seconds before Telegram answered. Sometimes the answer was "done, here is your message", sometimes "too many requests, try again in 8 seconds". Echo's server only waited 15 seconds. So it hung up before hearing either answer, and recorded the send as "we don't know if it went out". That state is deliberately never retried automatically, because retrying a message that might already have been delivered would send it twice. Some of those messages had in fact been delivered.

## What changes

1. The wait for an ordinary Telegram request goes from 15 seconds to 60 seconds, in both places that send (the main server and the lifeline process). Long polling already waited 60 seconds and is unchanged. With 60 seconds, a throttled send gets Telegram's real answer: either it is delivered and recorded, or Telegram says "too many requests", which the existing outbox already turns into a scheduled retry.
2. When a send still ends as "outcome unknown", the server writes one log line saying which request it was, the error, and how many milliseconds it waited. The line never includes the web address (which carries the bot's secret token), and anything that looks like a token is blanked out.

## What already exists and stays the same

The rule that an "outcome unknown" message is never resent automatically stays exactly as it is. Nothing new blocks or allows anything. The relay script that agents use to send already allows a request 125 seconds, so a 60 second network wait fits inside it.

## The trade-off

A request to a Telegram that is genuinely unreachable now takes up to 60 seconds to fail instead of 15. That only costs time on a path that was already failing, and the caller still gets the same answer.

## What to decide

Nothing beyond reviewing the change: it is small, and reverting it restores the old behaviour exactly.
