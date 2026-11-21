# ELI16 — A healthy server gets its full boot time back

## What this is about

Every agent has a small watcher process (the lifeline's "supervisor") that keeps
the agent's main server running. Every ten seconds it asks the server "are you
okay?". If the server stops answering, the supervisor restarts it.

A freshly restarted server needs time to boot before it can answer. Some boots
take more than two minutes on a busy machine. So after a restart the supervisor
gives the server a startup allowance of ten minutes, during which it does not
count unanswered checks against it.

There is also an upper limit on that allowance. If the server keeps being
restarted and never once answers, the supervisor stops being patient after
thirty minutes in total and goes back to acting on failures. That limit is
meant to cover one bad stretch: from the first restart until the server is
healthy again.

## What went wrong

The clock for that thirty-minute limit was supposed to start at the first
restart of a bad stretch. Because of a small ordering mistake, a healthy server
kept quietly resetting that clock to the moment it was originally started. So a
server that had been running fine for more than thirty minutes hit its first
problem with the limit already used up. Every restart in that outage then got
only about one minute instead of ten, and any boot slower than a minute was
killed and restarted again.

That is what happened on the Echo Laptop at 3:00 in the morning on
21 November 2026: boots that needed between 75 and 150 seconds were killed five
times in a row.

## What changes

The clock now only starts when a restart has happened and the new server has
not answered yet. A server that has been healthy, for any length of time, gets
the full ten-minute allowance on its next restart. If that restarted server never
becomes healthy, the clock stays anchored at that first restart through every
later restart, so the thirty-minute limit still ends a hopeless stretch.

## What stays the same

A server whose process has disappeared is still restarted at once. The circuit
breaker that stops endless restart loops, the handling for a laptop that went to
sleep, and the handling for a machine that is overloaded all work exactly as
before. Nothing new is stored, no setting changes, and no message to the user
changes.

## What a reader needs to decide

Nothing beyond the usual review. It is a one-line condition plus tests, and
undoing it is a plain revert.
