# The benchmark checker that never checked anything — plain English

## The one-sentence version

A system built to tell us when a model performs worse in real life than it did
on its test has never once given an answer, because two labels it compares
differ by a single character — and its way of saying "I can't tell" looks
exactly like it working properly.

## What the thing is for

We benchmark the models that make judgment calls — is this message safe to send,
is this process a runaway. The benchmark says "this model should get about 96% of
these right."

Then reality happens. The interesting question is whether reality agrees. If a
model scores 96% on the test and gets 70% right in production, something is
wrong: maybe the test is too easy, maybe production is harder than we thought,
maybe we picked the wrong model. That gap is worth knowing about.

So there's a checker whose whole job is to compare those two numbers and flag
disagreements.

## The safety check in front of it

Before comparing, it makes sure the benchmark it's holding actually corresponds
to what's running now. Prompts change. If someone rewrote the instructions since
the benchmark was taken, the old score describes something that no longer
exists, and comparing against it would be worse than not comparing at all — it
would blame a model for a test it never sat.

So the checker verifies the benchmark matches the live version. If it can't
confirm that, it refuses to judge and says so. **That refusal is correct
behaviour**, and remembering that is the key to the whole story.

## What was actually wrong

Part of that verification compares two labels describing where the tested text
lives.

One says `...MessagingToneGate.ts:TONE_GATE_PROMPT_TEMPLATE`.
The other says `...MessagingToneGate.ts#TONE_GATE_PROMPT_TEMPLATE`.

A colon in one, a hash in the other. Everything else identical. They're compared
character by character, so they never match, so the checker always concludes it
can't confirm what it's holding, so it always declines to judge.

Every task. Every run. Since the day it shipped.

## Why this went unnoticed, which is the real point

Because refusing to judge is a legitimate answer.

The checker runs on schedule. It completes without error. It emits a valid,
designed verdict: "precondition failed — can't verify the benchmark." Nothing
crashes. Nothing goes red. No alarm fires, because from the outside, a checker
that is permanently blindfolded produces exactly the same output as a checker
that is being appropriately careful about a stale benchmark.

The only way to notice is to ask "why has it never said anything else?" — and
then refuse to accept the reasonable-sounding answer.

## What I changed

Two things, and the second matters more.

**The character.** The labels now match, and the checker can get past its own
front door.

**Something that compares them.** A build check now verifies those two labels
are identical, and fails the build if they drift apart. It also checks the
benchmark still matches the live prompt, that every benchmarked task is one the
system knows about, and that none of them are empty.

The one-character typo was the bug. **The absence of anything comparing the two
labels was the defect.** A single character was allowed to silently disable an
entire subsystem, and nothing anywhere would have told us.

## What I deliberately did not do

The obvious "fix" is to make the comparison more forgiving — treat a colon and a
hash as the same thing. I didn't, and wouldn't.

That comparison is a safety check. Making it lenient would mean it stops
catching cases where the benchmark genuinely doesn't match what's running — and
then the checker would confidently blame models based on tests they never took.
That's a worse failure than saying nothing, because it produces confident
garbage instead of honest silence.

The strict comparison is right. What was missing was anything ensuring the two
sides stay in step. So the mismatch is now impossible to ship, rather than
tolerated at runtime.

## What you'd notice

Right now, nothing — until this ships and the checker starts producing real
verdicts for the first time.

When it does, expect its first answers to be unglamorous: mostly "not enough
evidence yet," because it needs a decent number of graded decisions before it
will commit to a claim. That's the system being careful, and this time it'll be
careful for the right reason rather than because it tripped over a punctuation
mark.
