# Attention cleanup runs on send-only servers — plain-English overview

## What this is

Instar keeps a list of "attention items": things the agent thinks the operator should look at, like a sign-in that needs repair or a reply that is being held. Last week that list grew past a thousand open items because nothing ever closed them. A recent change (PR #2361) added an hourly cleanup pass. It merges duplicate items about the same problem, closes items whose problem has been fixed, and closes untouched automated notices after two weeks with a label saying they expired rather than were handled.

## What was wrong

That cleanup only started when the server itself was reading Telegram messages. On most real setups the server is not the one reading messages. A small companion process called the lifeline does that, and the server only sends. In that "send-only" mode the cleanup timer was never started. So on every one of the operator's machines the hourly cleanup simply never happened. The only cleanups on record were two that were started by hand, and the status page kept showing that old time for hours.

## What changes

When the server starts in send-only mode, it now starts the same cleanup timers: one pass two minutes after boot, then one every hour. It is the same cleanup with the same rules; nothing about what gets closed changes. If the server later switches to reading messages itself, it does not start a second copy of the timer, and shutting the server down stops the timer as before.

## Safeguards

The cleanup's own safety rules are unchanged: the first pass on each machine only lists what it would expire, items the operator acknowledged or is working on are never expired, security items are never closed automatically, and a problem that is still active is never expired. The existing off switch for the whole cleanup still works without a new release.

## What you need to decide

Nothing. This makes an already-approved feature do what its documentation says.
