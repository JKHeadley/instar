# When I promise you something by a time, you hear from me at that time

## The short version

If I tell you "you'll have the result by noon" and noon passes without it, you now get one plain message at noon: what I promised, the time, and that it isn't marked done. The conversation where I made the promise gets a nudge too, so I either deliver it or tell you why it's late and give a new time. Before this change, nothing happened at all.

## What went wrong (case 1, 16–17 November)

You asked when another machine would help the build pipeline. I gave a three-part plan and recorded it as a promise with a target of noon the next day. No work happened for about 14 hours, noon passed, and you found out only when you asked.

When I looked at why, the promise record was fine. It had the noon time on it. **No code ever reads that time.** A promise can carry three different dates, and only one of them, the "check-in" date, has anything watching it. The "target time" date, the one I used, is written down and then ignored. The promise reminder that runs in the background looked busy (its "last heartbeat" kept updating) but it has messages to people switched off, so it never said anything. Across all my open promises, 40 had a target time that had passed, and none of them had produced a single message.

## What changes

1. **A promised time is watched.** A background check that already runs every five minutes, and already sends check-in reminders, now also looks at target times. When one passes and the promise is still open, you get one message in the same conversation.
2. **The message says only what is true.** "I told you this would be done by Tuesday 17 November, 12:00 PM. That time has passed and it isn't marked done", then the promise in quotes. It never says the work is unfinished, because sometimes it's done and I forgot to close the record. It never says "I'm on it", because that would be a claim nothing checks.
3. **The conversation that made the promise is told.** If that session is running, it gets a note 30 minutes before the time (deliver, or tell you the new time now). If the time passes, it gets a second note: deliver and close it, or tell you why it's late and the new time, or drop it only if you said so. If the session isn't running, nothing is started. You've been told, and your reply wakes it the normal way.
4. **I'm asked for a date when I forget one.** If I record a promise whose words say "by noon" but don't fill in the date, I'm told so right then, with the date worked out for me to confirm.

## What keeps it from being noisy

- **One message per promised time.** If I set a new time and miss that too, you get one more. After three missed times for the same promise, nothing more is sent.
- **One message per conversation per hour.** If several promises in one conversation go late together, they come as one message.
- **At most 3 conversations per check, and 12 per hour.** Anything over waits for the next check and is never dropped.
- **Only times I actually promised.** Some promise records carry automatic deadlines worked out from words like "soon". Those are ignored, so you never hear "this was due at 2:37" about a time nobody said.
- **Only my own work.** A promise that is waiting on you is not late on my side, so it's skipped.
- **The old backlog is not dumped on you.** Promises that were already overdue before this switched on were sorted by hand, each closed with evidence or kept. They don't produce messages.

## What it does not do yet

Two smaller fixes are filed separately: the reminder's startup limit (it keeps the 20 newest promises and switches off the rest for good), and showing a session its promises in due order when it starts. Neither is needed for you to hear about a missed time.

## Where it's switched on

It has no switch of its own: it rides on the existing check-in reminder, so it is live on Echo and off by default for other agents until that reminder is turned on for them. The check-in reminder's one setting turns it off again without a restart.

## What you need to decide

Nothing is required. The one judgment call is in the "Why this fits" section of the spec. Our rule says you aren't chased with status updates about my own work. I read a missed promised time as different: the time was itself a promise to you, so telling you closes my promise rather than starting a stream of updates. The existing "your update is late" message already works this way. If you see it differently, tell me and it is one switch.
