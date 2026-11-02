## What Changed

- The "The session has stopped. Send a new message to start a fresh session with full conversation context." notice is now sent at most once per unanswered user message, across server restarts. A small ledger (`state/session-monitor-dead-notified.json`) remembers the user message each notice answered; a dead session with no newer user message is never announced again. Before this, the repeat guards lived only in memory, so every restart re-announced the same death.
- Slack: the session monitor no longer treats every channel message as coming from the user. The agent's own posts (its notices included), other bots, people who are not authorized, and chatter the agent deliberately did not take in a mention-only channel no longer count as "a user is waiting". Before this, the agent's own notice counted as a new user message, so the notice re-armed itself and was posted again and again.
- Telegram: same notice ledger applies. A topic whose session dies again later, after a newer user message, is still told.

## What to Tell Your User

If your agent kept posting "The session has stopped" in a Slack channel over and over, that stops after this update. You will still get the notice once if you message the agent and its session has really stopped.

## Evidence

- Live symptom (2026-11-02): a Slack-only agent posted the notice in one channel about a dozen times in one morning, usually twice in a row, and the day before as well. Read-only inspection of that agent: one machine, about 69 server restarts since the evening of 2026-10-31 (auto-applied updates), mention-only channel, dead channel session, no new message in that channel — each restart's missed-message replay refilled the history with older chatter that counted as a waiting user.
- Unit tests (`tests/unit/session-monitor-dead-notice-once.test.ts`): 12 simulated restarts with no new user message post exactly one notice (was 12); the agent's own notice echoed back by Slack does not re-arm it; mention-only chatter is not a waiting user; a newer real user message is still announced; a corrupt ledger starts empty. The tests fail on the previous code.

## Summary of New Capabilities

None. This is a bug fix.
