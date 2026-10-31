# Upgrade Guide — vNEXT

## What Changed

- `src/messaging/telegram-egress.ts`: new exported `TELEGRAM_API_CALL_TIMEOUT_MS = 60_000`, the network timeout for every non-`getUpdates` Bot API call. It was 15 s.
- `src/messaging/TelegramAdapter.ts` `apiCall` and `src/lifeline/TelegramLifeline.ts` `apiCall` use it (long polling keeps its 60 s).
- `src/messaging/telegram-origin/TelegramOriginService.ts`: when a send's network call throws after it was invoked (the `transport-acceptance-unknown` branch), the server now writes one `console.warn` line naming the method, the operation id, the error (name, message, cause and code) and how long the network wait lasted. New exported helper `describeTransportUnknown()` builds it; it never includes the request URL and redacts anything shaped like a bot token.
- Why: on 2026-10-26 Telegram throttled Echo's bot for about an hour. Every chat-scoped request was held 14 to 33 s before Telegram answered, either with the result (200) or with `429 retry_after`. The 15 s clock fired first on nearly every send, so each one became a non-retryable `outcome-unknown` hold instead of a delivered message with its receipt or a 429 the origin outbox retries. Some of those "unknown" messages were in fact delivered. `logs/server.log` had no line for any of it.

## What to Tell Your User

If Telegram slows my bot down (it does this when the bot has been busy), my messages used to fail all at once and stay failed, and nothing in my logs said why. Now I wait long enough for Telegram's slow answer: the message either arrives, or Telegram tells me to wait and I retry it. If a send still ends in an unknown state, my log says exactly what went wrong.

## Summary of New Capabilities

- Telegram sends tolerate Telegram's throttled (slow) answers instead of timing out at 15 s.
- Every send that ends "outcome unknown" leaves a log line with its error and timing.

## Evidence

- Live measurement on the Mac Studio, 2026-10-26 13:52-14:10Z: in-process fetch probe on the running server showed `sendMessage` aborting at 15.0 s (TimeoutError) while the same bot's chat-scoped reads returned `429 retry_after 8` after 28-33 s and `getMe` answered in 0.5 s; other bots answered the same chat at once. With the network wait raised to 90 s in memory, a real origin-recorded send returned 200 after 14.4 s and was recorded (message 130522).
- Unit: `tests/unit/telegram-origin/transport-deadlines.test.ts` (+3: the log line through the real origin runtime, the timeout bound, token redaction; the Lifeline wiring test now asserts the shared constant), `tests/unit/telegram-api-edge.test.ts` (updated source assertion).
