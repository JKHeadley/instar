# In plain English: why terminal sessions pile up, and what this fixes

## The one-sentence version

Instar opens a short-lived terminal session to tick a box in another tool, and the
only thing that closes it afterwards is the program that opened it — so whenever
that program is stopped at the wrong moment, the session is left open forever.
This change makes the session close itself, and adds a regular sweep for any that
still get left behind.

## What is actually happening

When instar sets itself up on a machine, it has to tell a tool called Codex
"yes, these are my own safety checks, you may run them." Codex only asks that
question in an interactive screen, so instar opens a terminal session, launches
Codex in it, presses the right keys, and then closes the session.

The closing step runs in the same program that opened it. That sounds fine until
you notice when this setup runs: on **every update**. An update restarts instar.
So there is a moment, every single update, where the program that is supposed to
close the session is itself being shut down. When the timing lands badly, the
session is simply never closed. Nothing else is watching for it, because instar's
own list of sessions never contained it in the first place.

## Why it matters

Each abandoned session holds a running Codex at a prompt, doing nothing, using
memory. They accumulate at roughly eight a day on one machine.

On the operator's laptop on 25 October 2026 the result was measurable:
112 terminal sessions open while instar believed it had 11, nearly 1,500 programs
running at once, and 115 GB of the machine's 128 GB in use. The agent sharing that
machine, AI Guy, had slowed down so badly that its internal clock was slipping
8 to 19 seconds at a time, every scheduled task it tried to start died before
finishing startup, and a single message from the operator was re-sent about forty
times in nine minutes because nothing could answer in time. From the outside that
looked like "AI Guy is broken." He was not. He was queueing behind the mess.

## What already exists

The cleanup code exists and is correct for the normal case. It closes the session
in a second or two when nothing goes wrong. The problem is that it is the *only*
cleanup, so it has no answer for the case where it never gets to run.

## What is new

Two things, kept separate on purpose.

**The session now has its own timer, set in the same breath as it is created.**
The request that opens the session also tells the terminal server to close it ten
minutes later. Because it is one request, there is no moment in which the session
exists without its timer — the first draft set the timer in a second step, and a
crash between the two steps would have produced exactly the orphan being fixed.
The timer lives in the terminal server, so it keeps counting even if everything
that created it is gone. The existing cleanup still runs first in the normal case;
the timer is the floor underneath it. And if the timer cannot be set up safely, no
session is opened at all — a session without a net is the leak.

**A regular sweep.** Something has to handle the sessions that leaked before this
fix existed, and the rare case where the timer itself fails. A small watcher looks
at what is genuinely open on the machine and reports anything of this kind that
has been sitting idle for more than fifteen minutes.

The important detail is that the sweep looks at the **machine**, not at instar's
own list. That list is what made the problem invisible for days: it said 11 when
the real number was 112.

## The safeguards, in plain terms

- A session is only a candidate if its name carries its own birth time **and** that
  agrees with the terminal server's own record of when it was created. The name
  alone is something anyone could type; two independent records agreeing is not.
- Fifteen minutes is far longer than the job ever legitimately takes. The longest a
  healthy run can last, counting every timeout, is about two and a half minutes;
  the sweep will not act on anything younger than five, and the timer itself is set
  at ten.
- A session someone is actually looking at is never touched, however old it is.
- If the clock on the machine is wrong and a session looks like it was created in
  the future, it is left alone rather than treated as ancient.
- If the watcher cannot read the list of sessions, or cannot read the list of
  sessions it is told never to touch, it closes nothing at all that pass. It would
  rather do nothing than guess.
- It will not attempt more than fifty closes in one pass, nor spend more than about
  three seconds doing so, so a strange state cannot turn into a stampede or stall
  the server.
- If it keeps failing to read the list, it backs off and tries again hourly rather
  than giving up for good — the terminal server often starts *after* instar does.
- The timer that closes a session is silent and checks first. The review found
  that a bare "close this" fired after a session was already gone would write an
  error into some *other* session's screen and freeze it in a mode where instar's
  own messages stopped arriving. That is now impossible, and there is a test that
  checks a neighbouring session is untouched.

## What you need to decide

Nothing immediately. The sweep ships in **watch-only** mode: it reports what it
would close and closes nothing. The reason is that the timer stops new orphans at
the source, so the sweep only matters for a backlog that already exists — and its
report tells you, machine by machine, whether there is one. If a report shows a
real backlog, one setting turns it live, and that setting is read on the fly with
no restart. Turning the sweep off entirely is also one setting.

## What this does not fix

Two other things turned up in the same investigation and are deliberately left out
of this change, because mixing them would make all three harder to review:

1. Instar's own judgement of whether a machine is under strain is reading the wrong
   numbers on a Mac. That night it declared the laptop overwhelmed while 40% of the
   processors were idle, and declared memory fine while the machine was nearly full.
   Both errors point the same way: it stays out of the way exactly when it should step in.
2. Five separate instar agents share that laptop and none of them can see the others.
   Nobody is measuring the machine as a whole.

Both are tracked and will be their own changes.
