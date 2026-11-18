# Keeping promises before their time

## The short version

When I promise you something by a time, my job is to deliver it by then, not to tell you afterwards that I missed it. This change:

1. checks on the work twice before the time, and restarts it if the conversation doing it has stopped;
2. if the time still passes, hands the work back to a conversation to finish, and you hear nothing until the result arrives;
3. sends you a "missed" message only as a last resort, when I could not get the work restarted. That message says what was missed, why, and that I'm still on it. It never asks you to do anything.

## Why

Yesterday's version did it backwards. When a promised time passed, you got a list ("These were due and aren't marked done") and the work was handed on second. You said that dumps work on you. The agent should pick the work up and do it, tell you as little as possible, and only for a critical miss say what was missed and what it is doing about it. You also said the late path should be a last resort, and that the real goal is not missing promises in the first place.

Where promises slip today:

- I have 503 open promises. Only 36 have a time on them, so the other 467 can slip without anything noticing.
- 370 of them sit in conversations with no running session. When a conversation ends, nothing is working on its promise.
- The only check before the time is a note 30 minutes ahead. It only reaches a conversation that is still running, and if it fails it is never tried again.

## What changes

**Two checks before the time.** Halfway between making the promise and its time, and again 30 minutes before, the conversation is asked to make sure the work is moving and will be delivered on time. If the conversation has stopped, a new one is started for it. A check that doesn't get through is tried again until the next check is due. Starting a conversation this way is silent: you don't get the "session starting up" line you'd see when you message me yourself.

**After the time: pick it up, don't report it.** The conversation is told that you have NOT been told, and to do the work now. If it's already done, it sends you the result. If it really can't finish soon, it tells you once what was missed, what it's doing, and the new time. No time can move without you being told. Moving a time and telling you are one action: the system sends the message and only changes the time once it's delivered to you. The one exception is a single slip of up to 15 minutes when the result is nearly ready; then you just get the result. Each move reaches you with the new time, so you always know where it stands. And "done" after a pickup only counts once the result has actually been sent to you.

**Checking that the pickup worked.** After a while (scaled to how long the promise was, between 30 minutes and 4 hours), the promise must be delivered or have an honestly told new time. If not, it's picked up once more.

**Last resort.** You get one message only when I couldn't restart the work, or the restarts didn't get it done. Example: "I missed the time I gave you (Tuesday 12:00 PM) for this: "the scaling plan". Restarting the work failed. I'm still on it: I'll keep restarting it and send the result here when it's done." After that I keep trying, waiting longer each time, then once a day. After a week of daily tries it also goes to my promise review, which decides with evidence whether to keep going, close it as done, or retire it. If it retires something I told you I was still working on, you get one line saying I've stopped and why, so it never just disappears.

**Promises with no time.** A running conversation is asked, quietly, to add a time to its untimed promises or close the ones that are done. My existing promise review (it already runs every 6 hours and reads my open promises) gets two new choices: add the time the conversation actually gave, with a quote as proof, or mark the work as still owed so it gets picked up. It never invents a time, never cancels anything, and never messages you.

**Promised updates** ("you'll have my next update by 7") work the same way.

## What keeps it safe

- **No flood of new sessions.** Only the main machine starts them, through the same safety check every automatic start uses. At most 3 promise sessions are working at once on my main machine, they only start while the machine is below its normal session count (so your own conversations always have room), and a finished one is closed after 30 idle minutes only if you never wrote in it and nothing about it is uncertain. The untimed-promise work rides the review that already runs.
- **The promise text is treated as a quote, not an instruction.** The started conversation is told plainly that this note is from the system, not from you, so it can't approve anything on your behalf.
- **A busy machine isn't treated as a failure.** If the machine is too full to start a session, it waits and tries again. It only tells you once it has been stuck longer than the check interval.
- **One switch turns all of it off** (the same one as before), and a revert restores yesterday's behavior.

## What you're deciding

1. A missed promise goes to a conversation to finish. You hear when it's delivered, when the conversation honestly needs a new time, or as a last resort. This is your direction from 12:11.
2. The two checks before the time, both able to restart a stopped conversation.
3. The last resort goes out for any promise I couldn't get restarted, because otherwise it would die unseen. It never asks you to act.
4. Two new choices for the existing promise review, so untimed promises get a time or get picked up.

One gap is tracked separately: if the machine that owns a promise is off, nothing acts on it today.
