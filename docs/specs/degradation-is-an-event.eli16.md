# Degradation Is an Event — Plain-English Overview

## What broke

When I run on more than one machine, the machines pass a "who's in charge right
now" heartbeat between them. There's a little safety net that watches that
heartbeat, and if it stalls, the net quietly restarts it.

On the bad night, that heartbeat stalled for over ten minutes. The safety net did
its job and restarted it — but it did so completely silently, just a line in a log
file nobody was watching. So the coordination between my machines was running in a
degraded state, and the first anyone knew about it was when your messages started
disappearing. The failure was invisible until it hurt you.

## What this change does

It makes that stall an EVENT you'd actually hear about, not a buried log line. The
first time a stall happens, I now raise it through the same "something's degraded"
channel I already use for other problems — which surfaces to you. So if my
machines' coordination hiccups, you get a heads-up that it happened and recovered,
instead of it being silent.

It's careful not to nag: a single stall surfaces once (not on every retry), and the
runaway case (stalling over and over) is still its own louder alarm. It changes
nothing about HOW the safety net recovers the heartbeat — it only makes the
recovery visible.

## What you'll notice

If my multi-machine coordination ever briefly degrades and self-heals, you'll see a
brief "this degraded and recovered" note rather than silence. Most of the time you'll
see nothing, because most of the time nothing stalls. The point is the principle:
when something behind the scenes goes wrong, that's an event worth surfacing — not a
secret kept in a log.
