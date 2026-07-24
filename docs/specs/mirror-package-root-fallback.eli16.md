# ELI16 — The baseline shipped everywhere and was readable nowhere

## What happened

Earlier the same day, the first benchmark baseline was captured and shipped. It went
into the released package correctly — I confirmed the file was inside the published
archive rather than assuming the merge implied it.

Then I checked the serving machine, and it reported: no baseline.

## Why

The comparator looks for that file in one place: the agent's own working directory.
The released package installs somewhere else entirely — off in the dependencies
folder. On a development machine those happen to be the same directory, which is why
it worked when I tested it. On a normal machine they are not.

So the file was present on every install and readable on none of them.

## The part that makes this worth writing down

The comparator didn't report an error. It reported "no baseline captured" — which is
exactly what it had been reporting for the previous three weeks, when there genuinely
wasn't one.

A shipped-but-unreachable baseline and a never-captured baseline produce the
identical output. If I hadn't gone looking, the natural conclusion would have been
"the capture didn't work" or, worse, "everything's fine, it's just quiet."

This is the third time in one session the same shape has appeared: a check that
*cannot run* is indistinguishable from a check that *ran and found nothing wrong*.
First the commit gate that silently wasn't wired up. Then the comparator that had
never once run because it couldn't recognise the model it was watching. Now this.

## The fix

Look in the agent's own directory first; if the file isn't there, look inside the
installed package.

The order matters and isn't arbitrary. Someone working on a development machine may
have freshly regenerated their own baseline, and the shipped one must never quietly
override it. Their local copy wins; the shipped copy is the floor, not the authority.

Two details worth keeping honest. If someone gives an explicit full path to a
baseline file, that's an instruction, not a hint — it's used exactly as given and
never falls back to anything else. And the package location is worked out from where
the code itself lives, never from anything written inside a baseline file, because
those files are treated as untrusted input.

## Two things this shook loose

**A test that was doing its job.** My first attempt made the path-building function
check the filesystem itself, and an existing test immediately failed because that
function had a documented promise to be pure — same input, same answer, no disk
access. That was the right complaint, so the filesystem check moved into a separate
function and the pure one kept its promise.

**A latent bug in a test helper.** One test builds its configuration by merging in
overrides, and a stray spread at the end silently discarded fields that had been set
just above it. Nothing had noticed because nothing had depended on those fields
surviving. Now something does.

## What this still doesn't fix

The comparator's actual job is comparing predictions against real-world results.
Real-world results for this scenario don't exist yet. This makes the prediction half
readable; it doesn't close the loop.
