# ELI16 — a project round that cannot start should fail the round, not the whole agent

## What went wrong, in plain language

Instar can run a "project round": it starts a fresh AI session in the background and lets
it work through a list of items. Starting that session means launching a program called
`claude`.

Twice today, asking for a round to start **killed the entire agent server**. Not the round
— the whole thing. It restarted itself about eleven seconds later, and the round was left
sitting there marked "not started", with nothing written down anywhere explaining why.

## Why launching a program can kill the server

When a program cannot be launched at all — the file is not where we looked, or it is not
executable — the operating system does not report that the way you would expect. It does
not say "the program ran and failed". It reports a *separate* kind of event meaning "this
never started."

Nothing in the code was listening for that event. In Node.js, an event of that kind that
nobody listens for is escalated into a crash of the whole process. So a missing file at
launch became a dead server.

There is a deliberate policy in this codebase about which crashes are survivable, and it
crashes by default on anything it does not recognise. **That policy is correct and this
change does not touch it.** The right fix is not to teach the crash-handler to shrug at
this error; it is to stop leaving the launch unattended in the first place.

## The second problem, which is quieter and worse

Even if the crash had been prevented, the code that waits for the session to finish was
listening *only* for "the session ended". A session that never started never ends. So the
waiter would have sat there forever, waiting for something that could not happen.

So one line carried two faults: it could kill the server, and if it did not, it could hang.

## Why the program was missing

The agent server is started by the operating system at login, and that gives it a much
smaller list of places to look for programs than a normal terminal has. `claude` lives in
a directory that list does not include.

**This was already solved.** There is a helper in this codebase that knows how to find
these programs — it checks the standard locations, the places version managers install
things, and the search path. Five other parts of the system already use it. Its own notes
record a session-spawn crash from this same cause two months ago, which is exactly why it
learned to look in those extra places.

The round-starting code, written later, simply did not use it. So this change is not a new
mechanism — it is one call site finally reaching for the tool everyone else already uses.

## What changes

Two things.

**First**, the launch now asks that helper where the program is, instead of hoping the
operating system's short list happens to include it. If the helper genuinely cannot find
it, behaviour is unchanged from before.

**Second**, the launch now listens for "this never started". If that happens, the round is
recorded as failed with a reason that says so, and the run stops there.

That second half is the important one. Without it, the next launch failure for any other
reason — a permissions problem, a corrupted install — would still take the agent down.

## One deliberate decision worth flagging

The code normally retries a failed session a few times before giving up. A launch failure
deliberately does **not** consume one of those retries.

Retrying a program that is not there cannot succeed, so spending the attempts only delays
the answer — and worse, the round would then be recorded as "ran out of retries", which is
true-sounding and wrong. The problem was never that retries ran out. It is that the thing
never started.

"Could not start" and "started and then failed" are different facts, and the record must
not blur them.

## How we know it works

The tests launch a program that genuinely does not exist, so the failure is real rather
than simulated.

Run against the code *before* the fix, three of them fail — and the test run itself
reports the same crash the server suffered today. Run against the fixed code, all twelve
pass. A fourth test checks that an ordinary failed session still behaves exactly as it did
before; that one passes either way, and is labelled as a control rather than counted as
evidence.
