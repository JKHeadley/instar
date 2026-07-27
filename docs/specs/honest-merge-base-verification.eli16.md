# A safety guard said "not allowed", and the code wrote it down as "not there"

## What this actually is

When the project tracker records a piece of work as finished, it does not take anyone's word for
it. It goes and checks the pull request itself, and then asks one more question: **is that merge
genuinely on the main branch?**

That question has never once been answered correctly on this machine.

## What was happening

The check runs a version-control command that asks "is commit X an ancestor of main?". That
command is read-only and harmless. But it was being run *without declaring itself a read* — and we
have a safety guard whose job is to refuse operations against our own source code unless they say
what they are.

So the guard refused. Correctly. It was doing exactly what it exists to do.

Then the tracker caught that refusal and turned it into: **"this merge is not on the main
branch."**

Which was false. The merge *was* on main — provably, verifiably, one command away from being
confirmed. What actually happened was "I was not permitted to look", and the code converted it
into a confident statement about the world. There was even a comment on that line saying the
conversion was intended.

## Why this is the important half

There are two things wrong and they are not equally important.

The small one is the missing permission. The operation is already on the approved list for
read-only queries against our own source — the permission existed and simply was never asked for.
One word fixes it.

The big one is that **a refusal and a fact were indistinguishable in the answer.** The code caught
*every* possible failure — a refusal, a missing tool, a bad commit reference, a timeout — and
returned the same `false`, which the caller reads as "not on main". Fixing only the permission
would have made this one case work while leaving the mistranslation in place for whatever fails
next. And it explains why this step stayed broken for so long: every distinct cause presented
identically as a flat, confident no.

Now only one thing means "not an ancestor" — the specific exit code the version-control tool uses
to say so. Everything else comes back as **could not verify**, which is a different answer with a
different name, and the tracker reports it as such.

## Proved, not assumed

Reproduced under the same conditions the server runs in, before changing anything, then after:

| | result |
|---|---|
| the real merged commit, without declaring a read | **refused by the guard** → old code answered "not on main" |
| the real merged commit, declaring a read | **confirmed on main** — the true answer |
| a real commit genuinely *not* on main | exit code 1 — still correctly refused |
| a commit that does not exist at all | exit code 128 — now "could not verify", not "not there" |

That last row matters: a nonexistent commit is not a negative answer, it is an unanswerable
question, and the old code called it a negative too.

## The pattern, and where it came from

This is the same failure as everything else found in this audit: **the absence of information
rendering identically to the presence of information.** An empty map scoring one hundred percent
fresh. A commit gate printing "BLOCKED" and blocking nothing. A rules audit reporting on a quarter
of the rules. And now a permission refusal reported as a verified fact — inside the tool that
verifies whether work is complete.

Worth knowing: **this exact bug has happened before.** In May, the same missing declaration made a
different subsystem's checks silently fail while its dashboard cheerfully reported health. That
was fixed, and a guard was written to stop it recurring — but the guard was scoped to that one
subsystem. So the bug class survived, moved one subsystem over, and did the same thing again.

We measured how wide the exposure is rather than guessing: **34 of 46** similar calls across the
codebase do not declare themselves as reads. Most are probably fine — they operate on repositories
that are not our own source — but "probably fine" is not the same as checked. Sweeping all 34
blind would be exactly the kind of confident over-reach this whole project is about, so it is
recorded as measured work with a stated size rather than either fixed blindly or quietly dropped.

## A small thing found while writing the test

The test that forbids the old code shape initially failed — because it matched the *comment*
explaining why that shape was removed. A text-matching check, fooled by prose describing the thing
it forbids. Fixed by stripping comments first. Cheap to find at test-writing time; the same
mistake in a real gate is how you get a check that fires on nothing.
