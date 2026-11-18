# One stop decision per message

<!-- bump: patch -->

## What Changed

The safety check that watches incoming messages for "stop" now decides each message once. Before, when the same message reached the server more than once, the check asked its model again each time, and a single "stop" answer among them ended the session. That happened with relay re-sends: the relay re-sends after 10 seconds, and the check can take longer than that. On 2026-11-18 one correction was asked about 7 times; 6 answers said "keep working" and 1 said "stop", and that one ended the session.

The first decision for a message is now kept for 15 minutes and reused for every repeat of that message, including a repeat that arrives while the first check is still running. This covers Telegram (relay and polling), the phone app, and app messages forwarded between machines. Exact stop words still stop at once, and a stop the model infers is still a stop. If the model call fails or is shed for capacity, that fallback is not kept, and the next delivery is checked properly.

## What to Tell Your User

- **A correction no longer risks ending the session through repeat checks**: "If a message of yours reaches me twice because of a delivery retry, I now decide once whether it's a stop request, instead of re-checking it until one check says stop."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One stop verdict per inbound message | Automatic; `dispositionStats.decisionReused` counts reused verdicts |

## Evidence

- Unit: `tests/unit/MessageSentinel-one-verdict-per-message.test.ts` (11), replaying the incident's preserved answer order (redirect, emergency-stop, redirect ×5).
- Integration: `tests/integration/telegram-forward-sentinel-intercept.test.ts`: a re-sent forward through the real route makes one model call and no kill.
- Existing sentinel ratchets unchanged and passing.
