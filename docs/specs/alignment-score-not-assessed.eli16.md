# Telling "we have no data" apart from "you failed" — Plain-English Overview

> The one-line version: the tool that scores how well my decisions match our stated goals reported a
> flat zero and a grade of F when it had nothing to score. Nothing was wrong; there was simply
> nothing to look at. It had no way to say so.

## What was wrong

There is a score, out of a hundred, with a letter grade, meant to answer "are this agent's decisions
staying aligned with what we said we cared about?"

When it has no decisions to look at, it returned **zero out of a hundred, grade F**.

It did carry an honest sentence alongside — "No decisions logged, alignment cannot be assessed" — and
that sentence is exactly right. But the number and the letter are what anything actually reads. So
"we have no information" and "we looked, and it is as bad as it gets" came out identical on every
field a reader uses.

That is the same failure this whole stretch of work is about, landing on the instrument whose entire
job is honest measurement.

## The cause, which is small and familiar

The grade could only ever be one of A, B, C, D or F. There was no value meaning "no verdict". So when
there was nothing to grade, the code had to reach for one of the five real grades, and it picked the
worst one.

The fix is to widen the vocabulary: add an explicit "not applicable" grade, and a plain true/false
flag saying whether anything was actually assessed. This is the second time in two days the same
shape has come up — a set of possible answers too narrow to include "I do not know", forcing a
confident wrong answer instead.

## Two things I claimed that turned out to be false

I want these on the record, because I said them before checking and both were wrong.

**First**, I said the command-line view had been showing that red F for its entire life. It had not.
That command stops early and prints a genuinely helpful message when the log is empty — it never
reached the scoring section at all. The honest empty case was already handled there.

**Second**, I then assumed it was reachable whenever the log was merely stale. Also wrong. The early
stop and the scoring look at different time ranges — fourteen days and thirty days — and the shorter
one sits entirely inside the longer one, so anything that gets past the first check is inside the
second.

The real reachable case is narrower than either guess: it needs someone to widen the window past
thirty days by hand. Then a decision from forty days ago clears the early check but falls outside the
scoring range, and the command announces that alignment has collapsed when the truth is "nothing
logged in the last month".

The programmatic interface has no early stop at all, so anything reading the score directly — another
agent, a dashboard — sees the fabricated F straightforwardly. That consumer is the real one.

## The part I did not expect, for the third time

I have a rule that nothing counts as done until I break it on purpose and watch the tests object.

I broke the scoring logic, and the tests objected. Then I disabled the display code entirely, so the
honest message could never print — and **all twenty-eight tests still passed**. That is three times in
one night that the logic was carefully guarded while the connection to the surface a person actually
looks at was not guarded at all.

There is now a test that drives the real command and reads what it prints. Disable the display code
and it fails immediately.

## Something worth noticing about the old tests

Two existing tests asserted the broken behaviour on purpose — one checking the score came back as F,
another checking the same through the interface. They were not neglected; they were written to lock
in exactly the answer that was wrong.

A test can hold a mistake in place just as firmly as it can protect correct behaviour, and a passing
suite tells you nothing about which of the two it is doing.

## What this does not do

**It does not improve alignment.** Nothing here changes a single decision. It only stops the tool
lying about how much it knows.

**It does not fix the mismatched time ranges.** The early check and the scoring still use different
windows, which is the underlying oddity that makes the bad case reachable at all. Reconciling those
is a real change with its own consequences, and I have written it down rather than folding it in
here.

**Any non-empty answer still counts.** The score treats a decision as principled if it names any
guiding principle at all. Whether the principle was genuinely considered is not something this can
see.
