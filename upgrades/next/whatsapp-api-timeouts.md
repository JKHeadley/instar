# WhatsApp Business API calls have a 15-second timeout

<!-- bump: patch -->

## What Changed

SEC-132. The six calls `BusinessApiBackend` makes to Meta's Graph API (the token check in `connect()`, text, template and interactive sends, read receipts and reactions) had no timeout, so a stalled connection could leave a send hanging forever and back up replies behind it. Each call now passes `signal: AbortSignal.timeout(15000)`. A call that times out rejects like a network error, so the existing failure and retry handling applies.

## What to Tell Your User

- **Steadier WhatsApp**: "If WhatsApp's servers stop answering, I now give up after 15 seconds instead of getting stuck: a message goes back in my queue to send again, and a read tick or reaction is just skipped."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| 15-second timeout on every WhatsApp Business API call | Automatic |

## Evidence

- `tests/unit/BusinessApiBackend.test.ts` (2 new, both fail on main): all six calls pass an AbortSignal created with 15000 ms, and a send to a server that never answers rejects at the (shortened) timeout instead of hanging.
