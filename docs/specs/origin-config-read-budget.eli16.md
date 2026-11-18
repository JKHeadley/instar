# Telegram replies stop getting held when the server is busy (ELI16)

## What this changes

Before the agent sends a Telegram reply, it checks a recent copy of its own settings: which chat to post in, which bot, who the owner is. It refreshes that copy every few seconds and trusts a copy for 30 seconds. If no fresh copy arrives within 30 seconds, it holds replies rather than risk posting with outdated settings.

Each refresh had 10 seconds to finish. Reading the settings takes only about a twentieth of a second on its own, but it is done in about six small steps. When the server is busy with long back-to-back jobs, as it was on the Studio on 2026-11-17 and 18, each step waits in line behind one of those jobs. A refresh then took longer than 10 seconds and was thrown away. Two thrown-away refreshes in a row let the 30 seconds run out, and Justin's replies were held for a while, again and again.

This change gives a refresh 25 seconds instead of 10. It also reads two tiny settings files in one step instead of four, so each refresh waits in line fewer times.

## What stays the same

The 30-second limit is unchanged, and it is counted from the moment the settings were read, not from when the refresh finished. A slow refresh never makes the agent use older settings than before. A real problem with the settings (a changed bot, a missing chat, an unreadable file) still stops replies at once, exactly as before.

## Safeguards

The only cost of a longer refresh is that the next one starts a little later. Nothing waits on a refresh: replies always use the last good copy within its 30 seconds. Undoing the one commit restores the old timing, with nothing to repair. The tests check the new budget and the existing rules for slow and failed reads.

## What you need to decide

Nothing. This is a tuning fix. The cause of the busy server is being fixed separately (conversation graph checks that repeated the same work three times).
