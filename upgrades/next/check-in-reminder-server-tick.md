<!-- bump: patch -->

## What Changed

- **Dated promises now have something running their reminder check.** The check for promises whose date has arrived (`commitments.checkInReminder`) existed, but its only driver was a scheduled job that stayed off because each run would have started a full session. The server now runs that check itself every 5 minutes, with no session and no model call.
- **It stays in dry-run.** Nothing is sent by default. `logs/check-in-reminder-tick.jsonl` records which promises would be reminded, ids only, so the trial has real evidence. `GET /commitments/check-in-reminder` gains a `tick` block.
- **One pass at a time.** The timer and the manual pass route share one running pass. A pass stuck for 10 minutes is reported instead of overlapped.
- **Each machine reminds its own promises.** A row owned by another machine is never reminded here (`other-machine`).
- **Off switch.** `commitments.checkInReminder.tickEnabled: false`, read at every tick. `tickIntervalMs` sets the cadence and applies at server start.

## What to Tell Your User

Nothing changes for you yet. Your agent now keeps track of which dated promises are due, but it still sends no reminders. That stays off until a trial is reviewed.

## Summary of New Capabilities

- Dated check-in reminders are checked automatically by the server, without starting a session, in dry-run.

## Evidence

`tests/e2e/check-in-reminder-tick-exactly-once.test.ts` boots the real server, timer, commitment store and Telegram adapter over a stubbed Telegram endpoint: one due reminder is sent exactly once across several ticks and a restart, no session is spawned, and the default config sends nothing.
