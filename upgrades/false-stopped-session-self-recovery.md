# False stopped-session notices

## Outcome

Slack and Telegram conversations no longer get a stopped-session warning while a replacement is starting, a session is alive, or the agent has replied. A dead unanswered session is restarted automatically; one plain failure message is sent only when that recovery fails.

## Cause

On Indra, a failed resume retained the registered name while the successful fresh fallback generated a second name. The fallback answered Justin, but both health watchers followed the dead registered name. PresenceProxy also treated the first real reply as a brief acknowledgement and kept its timer running.

## Fix

The fallback now preserves the registered name. Both watchers check conversation state before death claims; SessionMonitor owns self-recovery and the single failure notice. Slack thread routing and foreign machine ownership use their actual routing and ownership records.

## Evidence

Indra's read-only server and Slack logs establish the original ordering. The fallback-name regression failed before the fix and passed after it. Monitor and proxy tests cover live, starting, replied, truly dead, and foreign-owned conversations. Live Slack canary and post-update Indra observation are required before the production outcome is claimed.
