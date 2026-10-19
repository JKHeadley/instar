# Three silent gates now say something

## What Changed

- A held Telegram reply raises its attention item per episode. The item id used to be just the topic, and the attention store ignores an id it already has, so every hold after the first on a topic was silent (a reply to topic 48154 on 2026-10-19 was held for hours behind an item from 2026-10-11). The "replies held on several topics" item and the expiry item are episode- and message-scoped the same way.
- The session watchdog no longer interrupts a `sleep N` before it has run N (plus a minute; never past the existing two-hour wait bound), and when it does interrupt a command it tells the session that owned it, once, so a poll loop or Monitor watch it ended is not reported as still running.
- Feedback triage raises one attention item when a quota pause (75% of a usage window, or an unreadable reading) lasts six hours while items are waiting.

## What to Tell Your User

If one of my replies is held again on a conversation where that happened before, you now get told again instead of nothing. And if feedback sorting stalls on usage for hours, you get one plain note saying so; it needs nothing from you.

## Summary of New Capabilities

- Held replies are announced every time they happen, not only the first time per conversation.
- Sessions are told when the watchdog stops one of their commands.
- A long feedback-triage quota pause is announced once.

## Evidence

- `tests/unit/telegram-origin-forward-on-standby.test.ts`: a hold on topic 48154 a week after the first gets a new id; a burst within an hour keeps one id; aggregates and expiries are per episode/operation.
- `tests/unit/session-watchdog-timed-sleep-and-notice.test.ts`: sleep parsing, the floor on both sides of N + 60 s and of the 2 h bound, the notice text, first-signal-only, and the server wiring (first-party injection, per-process dedupe).
- `tests/unit/feedback-factory/triage-service.test.ts`: no item before 6 h, one id per pause, a new id for a new pause, nothing when no item waits.
