# "I'll check in on this Friday" — plain English

## The one-sentence version

When I tell you I'll come back to something by a certain date, that promise
currently lives in my head; this turns it into something the system does whether
or not any part of me remembers.

## What happens today

You ask for something. I say "I'll report back on this by Friday." That sentence
is the whole mechanism. If the session I said it in ends, restarts, or gets
compacted away, Friday arrives and nothing happens. You find out by noticing.

There is a nudging system that pokes me about open promises, but it works on
rhythm — every so often, are you still on this? — not on dates. It has no
concept of "Friday specifically."

## What changes

A promise can now carry a date, and something separate from me watches for it.

Every few minutes a background check looks at open promises, finds the ones
whose date has arrived, and posts a message in the same conversation where the
promise was made. Once each. Then it stops.

The message says what I promised and that the date has come. It deliberately
does **not** say the work is done — a reminder that implies completion is worse
than no reminder, because it closes the question instead of reopening it.

## Two choices worth explaining

**Why one watcher instead of one alarm per promise.** The obvious approach is to
set an alarm clock for each promise. The instruction I was working from suggested
exactly that. I didn't, because setting an alarm requires *creating* something —
and anything that must be created can fail to be created. You'd get promises
with no alarm and no way to know which ones.

Instead, one watcher looks at every open promise every few minutes. There's
nothing to create, so nothing can be forgotten. And when a promise is fulfilled
or withdrawn, its alarm doesn't need cancelling — the watcher simply stops
seeing it. Both problems disappear rather than being handled.

**Why the order of operations matters, and how I got it wrong.**

My first version marked a reminder as "sent" *before* sending it. The reasoning
felt careful: if it crashes in between, better to lose one reminder than send
you a duplicate you can't un-receive.

A reviewer pointed out what that actually means. If the send fails — network
down, service hiccup — the promise is marked as reminded and **never fires
again**. A field named "sent" recording a moment when nothing was sent. On a
feature whose entire job is that promises don't get silently dropped.

I had spent the whole night finding systems that report success for things that
didn't happen, and then designed one into the fix.

It now sends first and only records success afterwards. The duplicate risk that
worried me is already handled one layer down: the message relay drops an
identical message to the same conversation within a short window, so a retry
after a crash is absorbed. That protection already existed. I'd have found it by
asking "what if the send fails?" instead of designing around the question.

If a send genuinely fails it retries a few times, then gives up **loudly** —
recorded as undelivered, visible, not disguised as delivered.

## Honest about what this is not yet

The instruction says it should be *impossible* to make a dated promise without a
reminder attached. Right now it ships switched off, and something switched off
guarantees nothing. What's true today: if the watcher is running, no dated
promise can slip past it individually. What isn't true yet: that the watcher is
guaranteed to be running.

Closing that gap is the final step — a check that refuses to accept a date on a
promise when nothing is watching for it, rather than accepting a date nothing
will honour. That check can't itself ship switched off, or it guarantees nothing
either.

## What you'd notice

Nothing until it's switched on, and then only this: on the day I said I'd check
in, a short message in that conversation saying so.

Not a status update. Not a claim of progress. Just the date arriving, out loud,
so it's yours to act on rather than mine to remember.
