# Console message dates include the day, month and year

<!-- bump: patch -->

## What Changed

On the dashboard's Conversations page, a message that is not from today now shows its day, month, year and time (for example "Nov 16, 2026, 9:01 PM") instead of only "Nov 16". A message from today still shows just its time. The "Pinned by" line in the list of pinned messages follows the same rule. The conversation list keeps its short stamp so it stays narrow. This matches the iPhone and Android apps.

## What to Tell Your User

- **Message dates on the dashboard**: "Older messages in the dashboard's Conversations page now show the full date with the year and the time, so you can tell exactly when something was sent. Today's messages still show only the time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Full date and time on older messages in the dashboard | Automatic |

## Evidence

Owner request, Telegram topic 134088, 2026-11-17 09:16 PST. Tests: `tests/unit/console-chats-model.test.ts` (today, yesterday 23:59 seen at 00:01, a 2025 date, unreadable input) and `tests/unit/console-chats-page.test.ts` (the shipped page in jsdom shows the year on an earlier-day bubble and pin line, time only for today; fails with the old helper: "expected 'Jan 3' to contain '2025'"). Real headless Chromium 158 run of the shipped `chats-model.js`: "Nov 16, 2026, 11:59 PM", "Jan 3, 2025, 9:05 AM", today "12:00 AM".
