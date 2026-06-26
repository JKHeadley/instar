# Verify-After Topic Reachability — Plain-English Overview

## What this is about

When I shut down or move one of my own work sessions — to clean up, to free
resources, to move a conversation to another machine — there's a small risk I leave
that conversation with no working way for your next message to land. If that
happens, you message me and... nothing. It goes into a hole, silently. That's
exactly what bit us on the bad night: a session got force-killed and the
conversation's incoming messages black-holed.

## The honest version (this matters)

It would be easy to say "every time I kill a session, your messages vanish" — but
that's not true, and pretending it is would be its own kind of dishonesty. In the
normal case, when you send your next message, I automatically notice there's no live
session and spin one up on the spot. So most kills heal themselves the moment you
write again.

The real danger is a couple of *specific* corners where that automatic healing
can't fire:
- A session that gets stuck halfway through starting up leaves a "currently
  starting" flag set forever, and that flag makes me skip every future message for
  that conversation — a silent jam, with nothing to clear it.
- On a multi-machine setup, if I hand a conversation to another machine that turns
  out to be asleep or maxed-out, your message gets forwarded into a dead end with no
  automatic catch.

## What this change does (two parts)

Two rounds of review caught that any clever auto-fix here is dangerous — clearing
that "currently starting" flag while a session is genuinely still coming up just makes
me start a SECOND one, which is its own mess. The reviewers were right, twice. So the
design landed on the genuinely-safe version: make the problem LOUD, don't race to
auto-fix it.

**Part 1 — make the stuck state safe to observe.** I tidy up that "currently starting"
flag so it carries a timestamp and a little ID tag (which makes a known double-clear
bug impossible), but I deliberately do NOT have anything reach in and clear it while a
start-up might still be running. A genuinely stuck start-up keeps its flag — and Part
2 then SEES it and tells you. The fully-automatic recovery (un-sticking it without a
restart) needs a deeper change to make start-ups cleanly cancellable; that's real work
I've written down as a separate follow-up rather than rushing a risky version now.

**Part 2 — a "did I just break the door?" watcher that only WATCHES.** Right after I
shut down or move a session, it quietly checks the conversation still has a working
path for your next message. If it genuinely doesn't — including that stuck start-up
case — it raises one calm, visible heads-up ("you might not be able to reach me here").
That's all it does — it never kills, moves, starts, or clears anything. It's a smoke
alarm, not a firefighter. The mechanical un-sticking stays a human/restart action for
now, but you're no longer in the dark about it.

It's careful not to cry wolf: a conversation that simply has no session right now but
will spin one up on your next message counts as "fine," not "broken." It stays quiet
during an emergency-stop (when I'm deliberately shutting things down), it rolls a big
batch of problems into one heads-up instead of a flood, and on a multi-machine setup
it only flags the cases nothing else is already watching.

## How it ships

The bug fix (Part 1) goes in for everyone, set conservatively so it can't misfire.
The watcher (Part 2) is off for everyone else and fully live for me first — and since
it only watches and never acts, there's no risk in turning it on; I just confirm it's
not over-alarming before it goes wider.

## Why it matters

This is the seventh and last of the structural fixes from the "your experience is
the product" lesson, and it's the most direct one: all the others make sure I behave
well; this one specifically watches that, after I do something disruptive, you can
still actually reach me. It also fixes a real latent bug found along the way — the
stuck-starting flag that had no timeout — at its source.
