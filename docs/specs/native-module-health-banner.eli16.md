# Saying once, where you will read it, that a broken part explains the mess

## What happened

A full test run on this machine reported 225 failing files. Nearly half of them
had a single cause: one small piece of the software — the bit that stores things
in a local database — had not been built properly when the project's dependencies
were installed. Everything that depended on it failed.

The software noticed. It said so clearly, in plain English, and it named the exact
command that fixes it. It said this **one hundred and eighty-nine times**.

That did not help. The message was scattered through a twenty-megabyte log among
tens of thousands of other lines. I searched that log, counted how often the error
appeared, and never read the three lines underneath the one I was counting — where
the cause and the cure were written. Hours went into elaborate investigations of a
question the output had already answered.

## What changes

Nothing new is detected, and nothing new is said. The **same** message is moved to
the one place a person actually looks: printed once, at the very end of the run,
directly beneath the failure count. It names the likely cause, says that failures
above it are probably consequences rather than separate problems, and gives the
one command that fixes it.

## What it deliberately does not do

- **It never stops anything.** The project is designed to keep working with that
  piece missing, and most tests do not touch it. Refusing to run would trade a
  confusing failure for a blocked one, which is worse.
- **It is completely silent when everything is fine** — which is nearly always.
  Adding a line to every healthy run would be adding to the very pile that caused
  the problem.
- **It watches one specific thing**, not "anything native". Generalising from a
  single incident would be inventing a pattern, which is the same over-reading
  that caused the original confusion.

## How we know it works

The end-to-end proof is not a claim about placement — the broken state was forced
and the run was watched. The banner appeared after the summary, where it was
supposed to. And the opposite case is tested too: given a healthy check, it writes
nothing at all and returns nothing to run later.

## What you would notice

On a healthy machine, nothing whatsoever. On a machine where that piece is broken,
one clear block of text at the end of the test run instead of hundreds of scattered
lines that are easy to count and easy not to read.
