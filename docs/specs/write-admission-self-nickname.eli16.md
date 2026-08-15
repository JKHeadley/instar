# ELI16 — the machine that refused a write couldn't say which machine it was

## What this is about

When the agent runs on more than one computer, only one of them owns a given
piece of state at a time. If the wrong one tries to write, it refuses — and the
refusal is supposed to tell you *which* machine owns it, so you know where to go
instead.

There is a status page for that mechanism. It reports the machine you are asking,
by id and by nickname — "the Mac Mini", "the laptop" — because an id is a
meaningless string of hex and a nickname is the thing you actually recognise.

## What was wrong

**The nickname was always empty.** Every machine, every time.

The status code asks for the nickname properly. The place that builds the whole
component simply never handed it one, and the code politely falls back to nothing
when it isn't given. So the field existed, was rendered, and was blank forever.

Nothing was broken in a dangerous way — no wrong machine was named, no write was
mis-refused. It is a piece of information that was supposed to be there and never
was.

## How I found it, and the mistake in the middle

This came from a peer agent's audit listing dependencies that are declared and
consumed but never supplied. I was checking the last few of its findings.

**My first check said the component is never built at all.** I searched for the
obvious spelling of "create one of these", got zero results, and was one step from
concluding the whole finding was moot.

It is built — just written with the module's name in front of it, a completely
ordinary way to write the same thing. My search only matched the bare spelling.

That is the *identical* blind spot I spent tonight fixing in three separate build
checks: a search that matches a bare name and misses the same name reached through
something else. I made it in my own investigation, while auditing for it. Which is
a fair argument for why those checks are worth having — the shape is genuinely hard
to see from the inside.

## What changed

One line at the place the component is built, handing it the lookup it was already
asking for. The lookup is the same one the rest of the file uses to turn a machine
id into a nickname.

## Why it can't make anything worse

The lookup is unavailable in some start-up situations, and a machine that isn't
registered in the pool has no nickname to find. **Both of those produce nothing —
which is exactly what the field showed before.** So this change can only ever add a
name where there was a blank; it cannot produce a wrong one, and it cannot fail.

## What I deliberately did not do

There is a fuller helper elsewhere in the codebase that can also *derive* a name
when a machine isn't registered anywhere. Using it here would mean changing imports
in a very large file where a differently-scoped function of the same name already
exists — real risk, for a display field. So a machine that is genuinely unknown to
the pool still shows nothing, exactly as today. Stated here rather than left for
someone to discover.

## How you know it works

The test reads the source and checks that every place the component is built hands
it the nickname lookup. Run against the old code it **fails**, naming the exact
line and saying what the consequence is. Nine further checks pass either way — one
proving the scan finds a construction at all (otherwise "every site is fine" would
be trivially true of zero sites), and the rest pinning that the scan matches the
module-qualified spelling, the bare spelling, and a deeply-qualified one, while
*not* matching a different class with a similar name, a plain import, or a type
mention.

That design comes straight from the mistake above: the scan is built to catch the
spelling that fooled me, and a test pins that it does.
