# A warning that looked the same the 39th time

## What happened

There is a safety limit that stops too many test suites running at once on one machine. It can be
switched off with an environment variable, and when it is, it prints a warning every single run:

> SKIPPING the host-wide test-runner bound — a self-disabled bound explains more incidents than a
> broken one.

That is a good warning. It is also identical every time.

I switched the limit off 37 times in about three hours. I saw that warning 37 times. It read as
routine test output, because on the 37th run it looked exactly like it did on the first.

Something did catch it: a separate detector counts how often the limit gets switched off and fails the
pre-flight check when the count passes three. It worked — but it surfaced hours later, in a different
command, long after every one of those 37 decisions had already been made.

## The gap

A warning that never changes cannot warn you about a pattern. It can only tell you about one event,
over and over, in the same tone. The reader is left to notice the repetition themselves, which is
exactly what nobody does at 3am on the 37th run.

## What changed

When the limit is switched off, the warning now also says how many times this has already happened
recently, that this is no longer an exception, and that the pre-flight check will fail on it.

It reuses the existing detector rather than counting separately, so the number in the warning and the
number that fails pre-flight can never disagree.

It is best-effort by design: if anything about looking up the count goes wrong, the original warning
still prints. A louder warning must never be able to break a test run.

## Two bugs found while building it, both by looking rather than by anything failing

The first version attached the lookup to a background task that nobody waited for. The setup finished
before it completed, so the escalation never printed at all. Nothing failed. There was simply no
output.

The second version guessed the shape of the detector's answer — the wrong field name, and a list where
there was actually an object. That error was caught by a safety net whose job is to make sure a
failed lookup cannot break the test run — so it swallowed the bug, silently, and again nothing printed
and nothing failed.

Both times the code was wrong in a way that produced no signal whatsoever. Both were found by running
it and reading the output. That is the same failure this change is about, occurring twice inside the
change itself: a safety net that stops a crash will also stop you learning that you were wrong.

The fix is that the part that can be wrong is now a separate, testable piece, checked against the
answer the real detector actually gives. A future change to that shape fails a test rather than
vanishing.
