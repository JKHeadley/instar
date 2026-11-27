# Side-Effects Review — console message dates include the day, month and year

**Version / slug:** `console-message-dates`
**Date:** `2026-11-17`
**Author:** `Echo`
**Second-pass reviewer:** `not required (display-only formatting)`

## Summary of the change

Owner request (Telegram topic 134088, 2026-11-17 09:16 PST): "If it's not the current day, message dates should include the date as in what day month year". The iPhone and Android apps already do this (InstarApp/MessageTime.swift). The web console's Conversations page used one helper, `shortTime`, which for any day other than today returned only month and day ("Nov 16"): no year and no time.

Change: a pure `messageTime(isoText, nowMs?, locale?)` in `dashboard/console/chats-model.js`. Today → the time only (unchanged); any other day → `toLocaleString` with year, short month, day, hour and minute ("Nov 16, 2026, 9:01 PM"). `chats.js` uses it for the message bubble time and the pin line. The conversation list row keeps the compact `shortTime` so the list stays narrow.

Tier 1, 4 files (2 source, 2 test), about 60 lines. One commit attempt planned, no spec review rounds (Tier 1, no spec).

## Decision-point inventory

None. Display formatting only; nothing gates, blocks or filters.

## 1. Over-block

No issue identified: nothing is rejected.

## 2. Under-block

No issue identified. Unreadable or missing times still render as empty text, as before.

## 3. Level-of-abstraction fit

Right layer: the pure model file already holds the page's view-model helpers and is unit tested; the page only calls it.

## 4. Signal vs authority compliance

Not applicable: no decision point (see `docs/signal-vs-authority.md`).

## 4b. Judgment-point check

None.

## 5. Interactions

`shortTime` is still used by the list row only. Other console pages have their own formatters and are untouched. Message bubbles are slightly wider for older messages; the time sits in the existing meta line, which already wraps.

## 6. External surfaces

Visible to the owner and team members on the console Conversations page. Locale follows the browser (`[]`), as the existing helper did. No routes, config or stored data.

## 7. Multi-machine posture

Machine-local by design: pure browser-side formatting of timestamps the server already sends; nothing replicated.

## 8. Rollback cost

Revert the commit; no state, no migration.

## Conclusion

Small display fix matching the phone apps. Ship.

## Evidence pointers

- `tests/unit/console-chats-model.test.ts`: today (time only), yesterday 23:59 vs now 00:01 (full date with year), a date in 2025, unreadable input.
- `tests/unit/console-chats-page.test.ts`: the shipped page in jsdom renders an earlier-day bubble and its pin line with the year and today's bubble with the time only; fails with the old helper.
